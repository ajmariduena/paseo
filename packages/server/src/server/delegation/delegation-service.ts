import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import { setupPermissionNotification } from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import {
  isDeliveryFinal,
  type DelegationStore,
  type DelegationTask,
  type PlanContext,
  type TerminalTaskStatus,
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
  private readonly unsubscribe: () => void;

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
    return task;
  }

  /** User Stop: results of children the stopped turn spawned or was waking for are dropped. */
  async stopActiveTurn(agentId: string): Promise<void> {
    const run = this.agentManager.getActiveRun(agentId);
    if (run) {
      await this.store.stopCohortsOfRun(agentId, run.key, new Date().toISOString());
    }
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
    const child = this.agentManager.getAgent(childAgentId);
    const stillWorking =
      child !== null &&
      (child.lifecycle === "running" ||
        child.lifecycle === "initializing" ||
        child.backgroundTasks.length > 0);
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
