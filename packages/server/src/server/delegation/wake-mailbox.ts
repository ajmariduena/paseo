import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import {
  dispatchAgentMessage,
  type MessageDisposition,
  type SystemMessage,
} from "../agent/message-dispatch.js";
import type { DelegationStore, DeliveryRef, PlanContext, WakeOffer } from "./delegation-store.js";
import { renderWakeMessage } from "./wake-text.js";

const MAX_DELIVERY_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 5_000;

export interface WakeMailboxOptions {
  store: DelegationStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  planContext(parentAgentId: string): Promise<PlanContext>;
  /** Whether the agent's most recent turn ended cancelled. */
  wasLastTurnCancelled(agentId: string): boolean;
  logger: Logger;
}

interface PreparedWake {
  message: SystemMessage;
  taskIds: string[];
}

/**
 * In-process doorbell for wakes. The durable delivery in the store is the source of truth:
 * every attempt re-reads it, so a stale or duplicate offer is dropped, and delivery is at
 * least once under the delivery's stable messageId.
 */
export class WakeMailbox {
  private readonly inFlight = new Set<string>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(private readonly options: WakeMailboxOptions) {}

  offer(offer: WakeOffer): void {
    this.attempt(offer, 0);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private attempt(offer: WakeOffer, attempt: number): void {
    const key = `${offer.parentAgentId}:${offer.cohortKey}:${offer.generation}:${offer.messageId}`;
    if (this.closed || this.inFlight.has(key)) {
      return;
    }
    this.inFlight.add(key);
    void this.deliver(offer)
      .catch((error: unknown) => {
        this.options.logger.error(
          { err: error, ...offer, attempt },
          "delegation.wake.delivery_failed",
        );
        this.retry(offer, attempt + 1);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
  }

  private retry(offer: WakeOffer, attempt: number): void {
    if (this.closed || attempt >= MAX_DELIVERY_ATTEMPTS) {
      return;
    }
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(timer);
        this.attempt(offer, attempt);
      },
      Math.min(100 * 2 ** attempt, MAX_RETRY_DELAY_MS),
    );
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  private async deliver(offer: WakeOffer): Promise<void> {
    const { store, agentManager, agentStorage, logger } = this.options;
    const parentAgentId = offer.parentAgentId;
    const initial = await this.prepare(offer);
    if (!initial) {
      return;
    }
    let rendered: string[] = initial.taskIds;
    const disposition: MessageDisposition = await dispatchAgentMessage({
      agentManager,
      agentStorage,
      agentId: parentAgentId,
      messageId: offer.messageId,
      policy: {
        kind: "system",
        maySteer: initial.maySteer,
        prepare: async () => {
          const wake = await this.prepare(offer);
          rendered = wake?.taskIds ?? [];
          return wake?.message ?? null;
        },
        onQueued: async () => {
          await store.markQueued(parentAgentId, offer);
        },
      },
      logger,
    });
    logger.trace({ ...offer, disposition }, "delegation.wake.dispatched");

    switch (disposition) {
      case "steered":
      case "out_of_band": {
        const successor = await store.acceptDelivery(
          parentAgentId,
          offer,
          rendered,
          await this.options.planContext(parentAgentId),
          new Date().toISOString(),
        );
        if (successor) this.offer(successor);
        return;
      }
      case "started":
      case "restarted":
        await this.followWakeRun(offer, rendered);
        return;
      case "skipped_archived":
        await store.disposeAll(parentAgentId, new Date().toISOString());
        return;
      case "dropped":
        return;
    }
  }

  private async followWakeRun(offer: WakeOffer, rendered: string[]): Promise<void> {
    const { store, agentManager } = this.options;
    const parentAgentId = offer.parentAgentId;
    const runKey = agentManager.getActiveRun(parentAgentId)?.key ?? null;
    const now = new Date().toISOString();
    if (!(await store.markStarted(parentAgentId, offer, runKey, rendered, now))) {
      return;
    }
    if (runKey) {
      await agentManager.waitForRunSettled(parentAgentId, runKey);
    }
    const successor = await store.settleWakeRun(
      parentAgentId,
      offer,
      { cancelled: this.options.wasLastTurnCancelled(parentAgentId) },
      await this.options.planContext(parentAgentId),
      new Date().toISOString(),
    );
    if (successor) this.offer(successor);
  }

  private async prepare(ref: WakeOffer): Promise<(PreparedWake & { maySteer: boolean }) | null> {
    const file = await this.options.store.get(ref.parentAgentId);
    const cohort = file?.cohorts[ref.cohortKey];
    const delivery = cohort?.delivery;
    if (!file || !cohort || cohort.disposition !== "open" || !isCurrent(delivery, ref)) {
      return null;
    }
    if (delivery.dispatch.kind === "started" || delivery.taskIds.length === 0) {
      return null;
    }
    const tasks = delivery.taskIds.flatMap((taskId) => file.tasks[taskId] ?? []);
    const delegatedInCohort = Object.values(file.tasks).filter(
      (task) => task.spawningRunKey === ref.cohortKey,
    ).length;
    return {
      message: renderWakeMessage(tasks, delegatedInCohort),
      taskIds: tasks.map((task) => task.id),
      maySteer: tasks.every((task) => task.completionWake === "always"),
    };
  }
}

function isCurrent<T extends { generation: number; messageId: string }>(
  delivery: T | null | undefined,
  ref: DeliveryRef,
): delivery is T {
  return (
    delivery != null &&
    delivery.generation === ref.generation &&
    delivery.messageId === ref.messageId
  );
}
