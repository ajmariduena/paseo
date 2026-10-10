import type { AgentQueueSnapshot } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";

import type { AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { MessageDisposition } from "../agent/message-dispatch.js";
import { HandoffOwnershipError } from "../handoff/ownership.js";
import {
  inDeliveryOrder,
  type AgentQueueEntry,
  type AgentQueueHeldReason,
  type AgentQueueStore,
  type DequeuedEntry,
  type NewQueueEntry,
  type HandoffQueue,
} from "./store.js";

export interface QueueDelivery {
  entry: AgentQueueEntry;
  /** The queued prompt as stored, after any edit; null for system entries. */
  prompt: AgentPromptInput | null;
  mode: "start" | "steer";
}

/** `busy` means another run took the agent first; the entry goes back to its place. */
export type QueueDeliveryResult = MessageDisposition | "busy";

export type QueueDeliverer = (delivery: QueueDelivery) => Promise<QueueDeliveryResult>;

/** Delivers entries that have no in-process sender, such as those that survived a restart. */
export type FallbackQueueDeliverer = (
  agentId: string,
  delivery: QueueDelivery,
) => Promise<QueueDeliveryResult>;

export interface QueuedMessage {
  entry: AgentQueueEntry;
  /** Resolves once the entry was delivered, or `dropped` when it left the queue undelivered. */
  settled: Promise<MessageDisposition>;
}

export interface AgentQueueRunnerHost {
  withMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
  isHandoffHeld(agentId: string): boolean;
  waitForRunToSettle(agentId: string): Promise<void>;
  subscribe(callback: (event: AgentManagerEvent) => void): () => void;
  isArchived(agentId: string): Promise<boolean>;
  /** Re-publishes the agent so clients see the new queue snapshot. */
  publish(agentId: string): void;
}

interface Waiter {
  deliver: QueueDeliverer;
  resolve(disposition: MessageDisposition): void;
  reject(error: unknown): void;
}

interface TerminalOutcome {
  seq: number;
  failed: boolean;
}

/**
 * Owns delivery of the durable per-agent queue: drains it one entry per settled run, holds it
 * after a failed turn or a user Stop, and resumes only when asked. The store is the source of
 * truth; in-process senders only wait here for their entry's outcome.
 */
export class AgentQueueRunner {
  private readonly waiters = new Map<string, Waiter>();
  private readonly drains = new Map<string, Promise<void>>();
  private readonly redrain = new Set<string>();
  private readonly outcomes = new Map<string, TerminalOutcome>();
  /** Stopped by the user and not revived since: system messages wait in a held queue. */
  private readonly userStopped = new Set<string>();
  private terminalSeq = 0;
  private fallback: FallbackQueueDeliverer | null = null;
  private closed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: AgentQueueStore,
    private readonly host: AgentQueueRunnerHost,
    private readonly logger: Logger,
  ) {}

  /** Starts observing turn outcomes; separate from construction so the host is fully built. */
  start(): void {
    this.unsubscribe ??= this.host.subscribe((event) => this.observe(event));
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  setFallbackDeliverer(deliverer: FallbackQueueDeliverer): void {
    this.fallback = deliverer;
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  snapshot(agentId: string): AgentQueueSnapshot | null {
    const file = this.store.peek(agentId);
    if (!file) return null;
    return {
      held: file.held,
      heldReason: file.heldReason,
      entries: inDeliveryOrder(file.entries).map((entry) => ({
        id: entry.id,
        origin: entry.origin,
        senderAgentId: entry.senderAgentId,
        position: entry.position,
        textPreview: entry.textPreview,
        attachmentCount: entry.attachmentCount,
        createdAt: entry.createdAt,
      })),
    };
  }

  agentIdsWithEntries(): string[] {
    return this.store.agentIds();
  }

  entries(agentId: string): AgentQueueEntry[] {
    return inDeliveryOrder(this.store.peek(agentId)?.entries ?? []);
  }

  exportForHandoff(
    agentId: string,
    options?: Parameters<AgentQueueStore["exportForHandoff"]>[1],
  ): Promise<HandoffQueue> {
    return this.store.exportForHandoff(agentId, options);
  }

  installHandoffQueue(agentId: string, reservationId: string, queue: HandoffQueue): Promise<void> {
    return this.store.installHandoffQueue(agentId, reservationId, queue);
  }

  async enqueue(
    agentId: string,
    input: NewQueueEntry,
    deliver: QueueDeliverer,
  ): Promise<QueuedMessage> {
    return this.host.withMutation(agentId, () => this.enqueueAdmitted(agentId, input, deliver));
  }

  private async enqueueAdmitted(
    agentId: string,
    input: NewQueueEntry,
    deliver: QueueDeliverer,
  ): Promise<QueuedMessage> {
    const entry = await this.store.enqueue(agentId, input, new Date().toISOString());
    if (this.userStopped.has(agentId)) await this.store.hold(agentId, "user_stop");
    const settled = new Promise<MessageDisposition>((resolve, reject) => {
      this.waiters.set(waiterKey(agentId, entry.id), { deliver, resolve, reject });
    });
    this.logger.trace({ agentId, entryId: entry.id, origin: entry.origin }, "agent.queue.enqueued");
    this.host.publish(agentId);
    this.kick(agentId);
    return { entry, settled };
  }

  /** Removes an entry before it is delivered. Its sender sees `dropped`. */
  async cancel(agentId: string, entryId: string): Promise<AgentQueueEntry | null> {
    return this.host.withMutation(agentId, () => this.cancelEntry(agentId, entryId));
  }

  /** The coordinator may dispose reviewed notifications after stopping ordinary queue mutations. */
  async cancelForHandoff(agentId: string, entryId: string): Promise<AgentQueueEntry | null> {
    this.requireHandoffFence(agentId);
    const entry = this.entries(agentId).find((candidate) => candidate.id === entryId);
    if (!entry) return null;
    if (entry.origin !== "system")
      throw new Error("Only process-bound notifications can be cancelled for handoff");
    return this.cancelEntry(agentId, entryId);
  }

  async holdForHandoff(agentId: string): Promise<void> {
    this.requireHandoffFence(agentId);
    await this.hold(agentId, "user_stop");
  }

  private requireHandoffFence(agentId: string): void {
    if (!this.host.isHandoffHeld(agentId))
      throw new Error("Queue handoff disposition requires the source fence");
  }

  private async cancelEntry(agentId: string, entryId: string): Promise<AgentQueueEntry | null> {
    const taken = await this.store.take(agentId, entryId);
    if (!taken) return null;
    await this.store.discard(agentId, taken.entry);
    this.settleWaiter(agentId, entryId, "dropped");
    this.host.publish(agentId);
    this.kick(agentId);
    return taken.entry;
  }

  /**
   * Sends a queued entry into the running turn now. A steer the provider cannot take puts the
   * entry back and rethrows; a turn that ended first makes it a new turn.
   */
  async promoteToSteer(agentId: string, entryId: string): Promise<MessageDisposition | null> {
    return this.host.withMutation(agentId, () => this.promoteAdmitted(agentId, entryId));
  }

  private async promoteAdmitted(
    agentId: string,
    entryId: string,
  ): Promise<MessageDisposition | null> {
    const taken = await this.store.take(agentId, entryId);
    if (!taken) return null;
    this.host.publish(agentId);
    return await this.deliver(agentId, taken, "steer");
  }

  async edit(agentId: string, entryId: string, text: string): Promise<AgentQueueEntry | null> {
    return this.host.withMutation(agentId, async () => {
      const edited = await this.store.edit(agentId, entryId, text);
      if (edited) this.host.publish(agentId);
      return edited;
    });
  }

  async reorder(agentId: string, entryIds: readonly string[]): Promise<boolean> {
    return this.host.withMutation(agentId, async () => {
      const reordered = await this.store.reorder(agentId, entryIds);
      if (reordered) this.host.publish(agentId);
      return reordered;
    });
  }

  /** A `user_stop` hold also covers an empty queue: what arrives later waits until resumed. */
  async hold(agentId: string, reason: AgentQueueHeldReason): Promise<void> {
    if (reason === "user_stop") this.userStopped.add(agentId);
    if (await this.store.hold(agentId, reason)) {
      this.logger.info({ agentId, reason }, "agent.queue.held");
      this.host.publish(agentId);
    }
  }

  async resume(agentId: string): Promise<void> {
    return this.host.withMutation(agentId, () => this.resumeAdmitted(agentId));
  }

  private async resumeAdmitted(agentId: string): Promise<void> {
    this.userStopped.delete(agentId);
    if (await this.store.resume(agentId)) {
      this.logger.info({ agentId }, "agent.queue.resumed");
      this.host.publish(agentId);
    }
    this.kick(agentId);
  }

  isHeldForUserStop(agentId: string): boolean {
    return this.userStopped.has(agentId);
  }

  /** The user sent the stopped agent a message; entries already held stay held until resumed. */
  releaseUserStop(agentId: string): void {
    this.userStopped.delete(agentId);
  }

  /** Boot: every queue that survived a restart waits for an explicit resume. */
  async holdAllForRestart(): Promise<void> {
    for (const agentId of this.store.agentIds()) {
      const dropped = await this.store.holdForRestart(agentId);
      this.logger.info({ agentId, dropped: dropped.length }, "agent.queue.held_after_restart");
    }
  }

  /** Archive: nothing queued for the agent is delivered. */
  async clear(agentId: string): Promise<void> {
    return this.host.withMutation(agentId, () => this.clearAdmitted(agentId));
  }

  private async clearAdmitted(agentId: string): Promise<void> {
    this.userStopped.delete(agentId);
    const removed = await this.store.clear(agentId);
    for (const entry of removed) this.settleWaiter(agentId, entry.id, "skipped_archived");
    if (removed.length > 0) this.host.publish(agentId);
  }

  private observe(event: AgentManagerEvent): void {
    if (event.type !== "agent_stream") return;
    const type = event.event.type;
    if (type === "turn_completed" || type === "turn_failed" || type === "turn_canceled") {
      this.outcomes.set(event.agentId, {
        seq: ++this.terminalSeq,
        failed: type === "turn_failed",
      });
    }
  }

  private kick(agentId: string): void {
    if (this.closed) return;
    if (this.drains.has(agentId)) {
      this.redrain.add(agentId);
      return;
    }
    const drain = (async () => {
      do {
        this.redrain.delete(agentId);
        await this.drain(agentId);
      } while (this.redrain.has(agentId) && !this.closed);
    })()
      .catch(async (error: unknown) => {
        this.logger.error({ err: error, agentId }, "agent.queue.drain_failed");
        if (error instanceof HandoffOwnershipError)
          await this.hold(agentId, "user_stop").catch((holdError: unknown) => {
            this.logger.error({ err: holdError, agentId }, "agent.queue.hold_failed");
          });
      })
      .finally(() => {
        this.drains.delete(agentId);
      });
    this.drains.set(agentId, drain);
  }

  private async drain(agentId: string): Promise<void> {
    // Captured before each delivery, so a turn that fails while the delivery finishes still holds.
    let seenSeq = this.terminalSeq;
    for (;;) {
      const file = this.store.peek(agentId);
      if (this.closed || !file || file.held) return;
      await this.host.waitForRunToSettle(agentId);
      if (this.closed) return;
      if (this.failedSince(agentId, seenSeq)) {
        // T3 holds on a provider failure other than a validation error; Paseo turns carry no
        // failure class, so every failed turn holds.
        await this.hold(agentId, "failure");
        return;
      }
      if (await this.host.isArchived(agentId)) return;
      const delivered = await this.host.withMutation(agentId, async () => {
        const next = await this.store.dequeueNext(agentId);
        if (!next) return false;
        this.host.publish(agentId);
        seenSeq = this.terminalSeq;
        try {
          await this.deliver(agentId, next, "start");
        } catch (error) {
          if (error instanceof HandoffOwnershipError) throw error;
          this.logger.error(
            { err: error, agentId, entryId: next.entry.id },
            "agent.queue.delivery_failed",
          );
        }
        return true;
      });
      if (!delivered) return;
    }
  }

  private failedSince(agentId: string, seq: number): boolean {
    const outcome = this.outcomes.get(agentId);
    return outcome !== undefined && outcome.seq > seq && outcome.failed;
  }

  private async deliver(
    agentId: string,
    taken: DequeuedEntry,
    mode: QueueDelivery["mode"],
  ): Promise<MessageDisposition | null> {
    const key = waiterKey(agentId, taken.entry.id);
    // Detached while delivering: a late steer re-queues under the same id with its own waiter.
    const waiter = this.waiters.get(key);
    this.waiters.delete(key);
    const delivery: QueueDelivery = { ...taken, mode };
    let result: QueueDeliveryResult;
    try {
      result = waiter
        ? await waiter.deliver(delivery)
        : await this.deliverWithoutSender(agentId, delivery);
    } catch (error) {
      if (mode === "steer" || error instanceof HandoffOwnershipError) {
        await this.putBack(agentId, taken, waiter);
      } else {
        await this.store.discard(agentId, taken.entry);
        waiter?.reject(error);
      }
      throw error;
    }
    if (result === "busy") {
      await this.putBack(agentId, taken, waiter);
      return null;
    }
    await this.store.discard(agentId, taken.entry);
    waiter?.resolve(result);
    this.logger.trace({ agentId, entryId: taken.entry.id, result }, "agent.queue.delivered");
    return result;
  }

  private async deliverWithoutSender(
    agentId: string,
    delivery: QueueDelivery,
  ): Promise<QueueDeliveryResult> {
    if (!this.fallback) {
      this.logger.warn({ agentId, entryId: delivery.entry.id }, "agent.queue.no_deliverer");
      return "dropped";
    }
    return await this.fallback(agentId, delivery);
  }

  private async putBack(
    agentId: string,
    taken: DequeuedEntry,
    waiter: Waiter | undefined,
  ): Promise<void> {
    if (waiter) this.waiters.set(waiterKey(agentId, taken.entry.id), waiter);
    await this.store.restore(agentId, taken.entry);
    this.host.publish(agentId);
  }

  private settleWaiter(agentId: string, entryId: string, disposition: MessageDisposition): void {
    const key = waiterKey(agentId, entryId);
    const waiter = this.waiters.get(key);
    this.waiters.delete(key);
    waiter?.resolve(disposition);
  }
}

function waiterKey(agentId: string, entryId: string): string {
  return `${agentId}\u0000${entryId}`;
}
