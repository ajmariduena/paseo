import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import { setupPermissionNotification } from "../agent/agent-prompt.js";
import { hasPendingDispatch } from "../agent/message-dispatch.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { QueueDelivery, QueueDeliveryResult } from "../agent-queue/runner.js";
import {
  isDeliveryFinal,
  type DelegationStore,
  type DelegationTask,
  type PlanContext,
  type TerminalTaskStatus,
  type WakeOffer,
} from "./delegation-store.js";
import { WakeMailbox } from "./wake-mailbox.js";

type TurnOutcome = "completed" | "failed" | "cancelled";

export interface DelegateInput {
  parentAgentId: string;
  childAgentId: string;
  source: DelegationTask["source"];
  title: string;
  prompt: string;
  /** A created child stops reporting to a parent it no longer belongs to. */
  requireParentOwnership: boolean;
}

export interface DelegationServiceOptions {
  store: DelegationStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

/**
 * Durable delegated tasks: a child's result is captured when it settles and wakes its parent
 * once per cohort of siblings, without ever interrupting the parent's turn.
 */
export class DelegationService {
  private readonly store: DelegationStore;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly logger: Logger;
  private readonly mailbox: WakeMailbox;
  private readonly lastTurnOutcomes = new Map<string, TurnOutcome>();
  /** child → parents with a running task for it. */
  private readonly runningChildren = new Map<string, Set<string>>();
  private readonly childChecks = new Map<string, Promise<void>>();
  private readonly queuedChildChecks = new Set<string>();
  private readonly finalizeWaiters = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(options: DelegationServiceOptions) {
    this.store = options.store;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.logger = options.logger.child({ module: "delegation" });
    this.mailbox = new WakeMailbox({
      store: this.store,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      planContext: (parentAgentId) => this.planContext(parentAgentId),
      wasLastTurnCancelled: (agentId) => this.lastTurnOutcomes.get(agentId) === "cancelled",
      logger: this.logger,
    });
    this.unsubscribe = this.agentManager.subscribe((event) => this.observe(event), {
      replayState: false,
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.mailbox.close();
  }

  async delegate(input: DelegateInput): Promise<DelegationTask> {
    const taskId = `dlg_${randomUUID()}`;
    const spawningRunKey =
      this.agentManager.getActiveRun(input.parentAgentId)?.key ?? `idle:${taskId}`;
    const task = await this.store.createTask(
      input.parentAgentId,
      {
        id: taskId,
        childAgentId: input.childAgentId,
        spawningRunKey,
        source: input.source,
        title: input.title,
        prompt: input.prompt,
        completionWake: "always",
      },
      new Date().toISOString(),
    );
    this.trackRunningChild(input.childAgentId, input.parentAgentId);
    setupPermissionNotification({
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      childAgentId: input.childAgentId,
      callerAgentId: input.parentAgentId,
      requireParentOwnership: input.requireParentOwnership,
      logger: this.logger,
    });
    this.scheduleChildCheck(input.childAgentId);
    return task;
  }

  /**
   * The parent read the child's terminal result through its own tools, so a wake that has not
   * started yet no longer needs to carry it. Returns the child's latest terminal task.
   */
  async acknowledgeChildResults(input: {
    parentAgentId: string;
    childAgentId: string;
  }): Promise<DelegationTask | null> {
    const observedByRunKey = this.agentManager.getActiveRun(input.parentAgentId)?.key ?? null;
    const task = await this.store.acknowledgeChildResults(
      input.parentAgentId,
      input.childAgentId,
      observedByRunKey,
      new Date().toISOString(),
    );
    this.logger.trace({ ...input, taskId: task?.id ?? null }, "delegation.acknowledged");
    await this.pruneQueuedWakes(input.parentAgentId);
    return task;
  }

  /**
   * A parent blocking on its child holds the child's wake while its current run is live, so
   * the result it is about to read does not also arrive as a wake. Pair with `endWait`.
   */
  async beginWait(input: { parentAgentId: string; childAgentId: string }): Promise<void> {
    const waitRunKey = this.agentManager.getActiveRun(input.parentAgentId)?.key ?? null;
    if (!waitRunKey) return;
    await this.store.setWakePolicy(
      input.parentAgentId,
      input.childAgentId,
      { completionWake: "settled_only", waitRunKey },
      await this.planContext(input.parentAgentId),
      new Date().toISOString(),
    );
  }

  /** A wait that ended without reading the result upgrades it to wake the parent. */
  async endWait(input: { parentAgentId: string; childAgentId: string }): Promise<void> {
    const offer = await this.store.setWakePolicy(
      input.parentAgentId,
      input.childAgentId,
      { completionWake: "always", waitRunKey: null },
      await this.planContext(input.parentAgentId),
      new Date().toISOString(),
    );
    if (offer) this.mailbox.offer(offer);
  }

  /** Resolves once the parent has no running task for the child, or rejects on abort. */
  async waitForChildResult(input: {
    parentAgentId: string;
    childAgentId: string;
    signal: AbortSignal;
  }): Promise<void> {
    for (;;) {
      input.signal.throwIfAborted();
      const finalized = this.nextFinalize(input.signal);
      if ((await this.runningTaskIds(input.parentAgentId, input.childAgentId)).length === 0) {
        finalized.cancel();
        return;
      }
      await finalized.promise;
    }
  }

  private nextFinalize(signal: AbortSignal): { promise: Promise<void>; cancel: () => void } {
    let settle: () => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.finalizeWaiters.delete(settle);
        reject(signal.reason);
      };
      settle = () => {
        this.finalizeWaiters.delete(settle);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.finalizeWaiters.add(settle);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    promise.catch(() => undefined);
    return { promise, cancel: () => settle() };
  }

  /** The parent cancelled its child, so the child's results no longer wake it. */
  async disposeChildTasks(input: { parentAgentId: string; childAgentId: string }): Promise<void> {
    await this.store.disposeChildTasks(
      input.parentAgentId,
      input.childAgentId,
      new Date().toISOString(),
    );
    await this.pruneQueuedWakes(input.parentAgentId);
  }

  /** The user cancelled a queued wake: its cohort stops waking the parent. */
  async disposeQueuedWake(parentAgentId: string, messageId: string): Promise<void> {
    await this.store.disposeWake(parentAgentId, messageId, new Date().toISOString());
  }

  /** Re-checks a child whose queued message finished dispatching without a state change. */
  refreshChild(childAgentId: string): void {
    if (this.runningChildren.has(childAgentId)) this.scheduleChildCheck(childAgentId);
  }

  /** User Stop: results of children the stopped turn spawned or was waking for are dropped. */
  async stopActiveTurn(agentId: string): Promise<void> {
    const run = this.agentManager.getActiveRun(agentId);
    if (run) {
      await this.store.stopCohortsOfRun(agentId, run.key, new Date().toISOString());
      await this.pruneQueuedWakes(agentId);
    }
  }

  /** Removes queued wakes whose delivery was acknowledged, disposed, or replaced. */
  private async pruneQueuedWakes(parentAgentId: string): Promise<void> {
    const queue = this.agentManager.messageQueue;
    const wakes = queue.entries(parentAgentId).filter((entry) => entry.wake !== null);
    if (wakes.length === 0) return;
    const file = await this.store.get(parentAgentId);
    for (const entry of wakes) {
      const cohort = entry.wake ? file?.cohorts[entry.wake.cohortKey] : undefined;
      const delivery = cohort?.delivery;
      const isCurrent =
        cohort?.disposition === "open" &&
        delivery?.messageId === entry.id &&
        delivery.dispatch.kind !== "started";
      if (!isCurrent) await queue.cancel(parentAgentId, entry.id);
    }
  }

  /**
   * Boot pass after a restart, before anything is live. A child the restart cut reports
   * `cancelled`; a wake turn the restart cut gives its results back to a successor wake; a wake
   * that was claimed but never dispatched is offered once; a wake waiting in the parent's queue
   * stays there, held with the rest of the queue. A child that had settled before the restart
   * but whose result was not recorded yet is reloaded so its result comes from its history.
   */
  async recoverAfterRestart(cutAgentIds: ReadonlySet<string>): Promise<void> {
    const offers = new Map<string, WakeOffer>();
    const settledChildren = new Map<string, string[]>();
    for (const parentAgentId of await this.store.listParents()) {
      for (const offer of await this.recoverDeliveries(parentAgentId)) {
        offers.set(offer.messageId, offer);
      }
      const file = await this.store.get(parentAgentId);
      const runningTasks = Object.values(file?.tasks ?? {}).filter(
        (task) => task.status === "running",
      );
      for (const task of runningTasks) {
        const childRecord = await this.agentStorage.get(task.childAgentId);
        const childGone = !childRecord || Boolean(childRecord.archivedAt);
        if (childGone || cutAgentIds.has(task.childAgentId)) {
          const offer = await this.finalizeCutTask(parentAgentId, task, childGone);
          if (offer) offers.set(offer.messageId, offer);
          continue;
        }
        const parents = settledChildren.get(task.childAgentId) ?? [];
        settledChildren.set(task.childAgentId, [...parents, parentAgentId]);
      }
    }
    this.logger.info(
      { offers: offers.size, settledChildren: settledChildren.size },
      "delegation.recovered_after_restart",
    );
    for (const offer of offers.values()) this.mailbox.offer(offer);
    for (const [childAgentId, parents] of settledChildren) {
      void this.reloadSettledChild(childAgentId, parents);
    }
  }

  /** Delivers a wake that waited in the parent's queue across a restart. */
  async deliverQueuedWake(
    parentAgentId: string,
    delivery: QueueDelivery,
  ): Promise<QueueDeliveryResult> {
    const { wake } = delivery.entry;
    if (!wake) return "dropped";
    return await this.mailbox.deliverQueued(
      { parentAgentId, ...wake, messageId: delivery.entry.id },
      delivery.mode,
    );
  }

  private async recoverDeliveries(parentAgentId: string): Promise<WakeOffer[]> {
    const file = await this.store.get(parentAgentId);
    if (!file) return [];
    const queuedIds = new Set(
      this.agentManager.messageQueue.entries(parentAgentId).map((entry) => entry.id),
    );
    const offers: WakeOffer[] = [];
    for (const [cohortKey, cohort] of Object.entries(file.cohorts)) {
      const delivery = cohort.delivery;
      if (!delivery || cohort.disposition !== "open") continue;
      const offer: WakeOffer = {
        parentAgentId,
        cohortKey,
        generation: delivery.generation,
        messageId: delivery.messageId,
      };
      switch (delivery.dispatch.kind) {
        case "started": {
          const successor = await this.store.settleWakeRun(
            parentAgentId,
            offer,
            { cancelled: true },
            await this.planContext(parentAgentId),
            new Date().toISOString(),
          );
          if (successor) offers.push(successor);
          break;
        }
        case "queued":
          if (!queuedIds.has(delivery.messageId)) {
            await this.store.unmarkQueued(parentAgentId, offer);
            offers.push(offer);
          }
          break;
        case "none":
          if (queuedIds.has(delivery.messageId)) {
            await this.store.markQueued(parentAgentId, offer);
          } else {
            offers.push(offer);
          }
          break;
      }
    }
    return offers;
  }

  private async finalizeCutTask(
    parentAgentId: string,
    task: DelegationTask,
    childGone: boolean,
  ): Promise<WakeOffer | null> {
    const status: TerminalTaskStatus = childGone ? "interrupted" : "cancelled";
    const childRecord = await this.agentStorage.get(task.childAgentId);
    const ownedByParent = getParentAgentIdFromLabels(childRecord?.labels) === parentAgentId;
    const offer = await this.store.finalizeTask(
      parentAgentId,
      task.id,
      {
        status,
        result: `Child task ended with status ${status}.`,
        wake: task.source !== "create_agent" || ownedByParent,
      },
      await this.planContext(parentAgentId),
      new Date().toISOString(),
    );
    this.logger.trace({ parentAgentId, taskId: task.id, status, offer }, "delegation.finalized");
    return offer;
  }

  /**
   * Its history holds the result the restart kept from being recorded. Tracked only once
   * loaded, so a state event mid-load cannot capture the result before the history replays.
   */
  private async reloadSettledChild(childAgentId: string, parents: string[]): Promise<void> {
    try {
      await ensureAgentLoaded(childAgentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
    } catch (error) {
      this.logger.warn({ err: error, childAgentId }, "delegation.settled_child_reload_failed");
    }
    for (const parentAgentId of parents) this.trackRunningChild(childAgentId, parentAgentId);
    this.scheduleChildCheck(childAgentId);
  }

  async disposeForArchivedAgent(agentId: string): Promise<void> {
    await this.store.disposeAll(agentId, new Date().toISOString());
  }

  private observe(event: AgentManagerEvent): void {
    if (event.type === "agent_stream") {
      const outcome = turnOutcome(event.event.type);
      if (outcome) this.lastTurnOutcomes.set(event.agentId, outcome);
      return;
    }
    if (event.type === "agent_state" && this.runningChildren.has(event.agent.id)) {
      this.scheduleChildCheck(event.agent.id);
    }
  }

  private trackRunningChild(childAgentId: string, parentAgentId: string): void {
    const parents = this.runningChildren.get(childAgentId) ?? new Set<string>();
    parents.add(parentAgentId);
    this.runningChildren.set(childAgentId, parents);
  }

  /** At most one check runs and one waits per child, however many state events arrive. */
  private scheduleChildCheck(childAgentId: string): void {
    if (this.queuedChildChecks.has(childAgentId)) return;
    this.queuedChildChecks.add(childAgentId);
    const previous = this.childChecks.get(childAgentId) ?? Promise.resolve();
    const next = previous
      .then(() => {
        this.queuedChildChecks.delete(childAgentId);
        return this.checkChild(childAgentId);
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error, childAgentId }, "delegation.child_check_failed");
      });
    this.childChecks.set(childAgentId, next);
    void next.finally(() => {
      if (this.childChecks.get(childAgentId) === next) this.childChecks.delete(childAgentId);
    });
  }

  /** Port of T3 `delegatedTaskProgress`: a child has a result only once all its work settled. */
  private async checkChild(childAgentId: string): Promise<void> {
    const parents = [...(this.runningChildren.get(childAgentId) ?? [])];
    if (parents.length === 0) {
      return;
    }
    await this.agentManager.waitForRunToSettle(childAgentId);
    // Shutdown closes children without settling their work; boot recovery reports them.
    if (this.closed) return;
    const child = this.agentManager.getAgent(childAgentId);
    const stillWorking =
      child !== null &&
      (child.lifecycle === "running" ||
        child.lifecycle === "initializing" ||
        child.backgroundTasks.length > 0 ||
        hasPendingDispatch(this.agentManager, childAgentId));
    if (stillWorking || (await this.hasOpenDelegations(childAgentId))) {
      this.logger.trace({ childAgentId }, "delegation.child_still_working");
      return;
    }
    // Only tasks that existed when the child settled take this result; a follow-up delegated
    // meanwhile waits for the child's next settle.
    const settledTasks = await Promise.all(
      parents.map(async (parentAgentId) => ({
        parentAgentId,
        taskIds: await this.runningTaskIds(parentAgentId, childAgentId),
      })),
    );
    const status = this.terminalStatus(childAgentId, child);
    const result = await this.captureResult(childAgentId, child, status);
    for (const { parentAgentId, taskIds } of settledTasks) {
      await this.finalizeForParent({ parentAgentId, childAgentId, taskIds, status, result });
    }
  }

  private async runningTaskIds(parentAgentId: string, childAgentId: string): Promise<string[]> {
    const file = await this.store.get(parentAgentId);
    return Object.values(file?.tasks ?? {})
      .filter((task) => task.childAgentId === childAgentId && task.status === "running")
      .map((task) => task.id);
  }

  private async finalizeForParent(input: {
    parentAgentId: string;
    childAgentId: string;
    taskIds: string[];
    status: TerminalTaskStatus;
    result: string;
  }): Promise<void> {
    const file = await this.store.get(input.parentAgentId);
    if (!file) return;
    const childRecord = await this.agentStorage.get(input.childAgentId);
    const ownedByParent = getParentAgentIdFromLabels(childRecord?.labels) === input.parentAgentId;
    const context = await this.planContext(input.parentAgentId);
    for (const taskId of input.taskIds) {
      const task = file.tasks[taskId];
      if (!task) continue;
      const offer = await this.store.finalizeTask(
        input.parentAgentId,
        taskId,
        {
          status: input.status,
          result: input.result,
          wake: task.source !== "create_agent" || ownedByParent,
        },
        context,
        new Date().toISOString(),
      );
      this.logger.trace(
        { parentAgentId: input.parentAgentId, taskId, offer },
        "delegation.finalized",
      );
      if (offer) this.mailbox.offer(offer);
    }
    if ((await this.runningTaskIds(input.parentAgentId, input.childAgentId)).length === 0) {
      this.untrackRunningChild(input.childAgentId, input.parentAgentId);
    }
    for (const notify of this.finalizeWaiters) notify();
    if (this.runningChildren.has(input.parentAgentId)) {
      this.scheduleChildCheck(input.parentAgentId);
    }
  }

  private untrackRunningChild(childAgentId: string, parentAgentId: string): void {
    const parents = this.runningChildren.get(childAgentId);
    parents?.delete(parentAgentId);
    if (parents?.size === 0) this.runningChildren.delete(childAgentId);
  }

  private async hasOpenDelegations(agentId: string): Promise<boolean> {
    const file = await this.store.get(agentId);
    if (!file) return false;
    return Object.values(file.tasks).some(
      (task) => task.status === "running" && !isDeliveryFinal(task),
    );
  }

  private terminalStatus(childAgentId: string, child: ManagedAgent | null): TerminalTaskStatus {
    const outcome = this.lastTurnOutcomes.get(childAgentId);
    if (child?.lifecycle === "error" || outcome === "failed") return "failed";
    if (outcome === "cancelled") return "cancelled";
    if (!child || child.lifecycle === "closed") {
      return outcome === "completed" ? "completed" : "interrupted";
    }
    return "completed";
  }

  /** Port of T3 `delegatedTaskResult`. */
  private async captureResult(
    childAgentId: string,
    child: ManagedAgent | null,
    status: TerminalTaskStatus,
  ): Promise<string> {
    if (status === "failed" && child?.lastError) {
      return child.lastError;
    }
    const lastMessage = (await this.agentManager.getLastAssistantMessage(childAgentId))?.trim();
    if (lastMessage) {
      return lastMessage;
    }
    return status === "completed"
      ? "Child task completed without an assistant result."
      : `Child task ended with status ${status}.`;
  }

  private async planContext(parentAgentId: string): Promise<PlanContext> {
    const record = await this.agentStorage.get(parentAgentId);
    return {
      parentArchived: Boolean(record?.archivedAt),
      isRunLive: (runKey) => this.agentManager.isRunLive(parentAgentId, runKey),
    };
  }
}

function turnOutcome(type: string): TurnOutcome | null {
  if (type === "turn_completed") return "completed";
  if (type === "turn_failed") return "failed";
  if (type === "turn_canceled") return "cancelled";
  return null;
}
