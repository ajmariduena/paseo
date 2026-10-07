import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import type { DelegationService } from "../delegation/delegation-service.js";
import type { PullRequestWatcher } from "../pull-request-watch/watcher.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { cancelAgentRunCommand, type CancelAgentRunResult } from "./lifecycle-command.js";

export type StoppedRunAction = "create_agent" | "watch_pull_request";

/** A tool call from a run the user already stopped. */
export class AgentRunStoppedError extends Error {
  constructor(
    readonly agentId: string,
    readonly action: StoppedRunAction,
  ) {
    super(
      `The user stopped agent ${agentId}, so ${action} is refused for the run they stopped. Do not retry; end your turn and wait for the user.`,
    );
    this.name = "AgentRunStoppedError";
  }
}

export interface AgentStopOptions {
  agentManager: AgentManager;
  agentStorage: Pick<AgentStorage, "list">;
  delegations: Pick<DelegationService, "stopAll"> | null;
  pullRequestWatches: Pick<PullRequestWatcher, "disposeForAgent"> | null;
  logger: Logger;
}

/**
 * Port of T3's stop cascade: stopping an agent stops the work it started. The agent and every
 * live Paseo-owned descendant hold their queues, drop their child results and pull request
 * watches, and cancel their runs, so nothing revives them until the user resumes or writes.
 */
export class AgentStop {
  private readonly agentManager: AgentManager;
  private readonly agentStorage: Pick<AgentStorage, "list">;
  private readonly delegations: Pick<DelegationService, "stopAll"> | null;
  private readonly pullRequestWatches: Pick<PullRequestWatcher, "disposeForAgent"> | null;
  private readonly logger: Logger;
  /** agent → key of the run Stop reached, null when it was idle. */
  private readonly stoppedRuns = new Map<string, string | null>();

  constructor(options: AgentStopOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.delegations = options.delegations;
    this.pullRequestWatches = options.pullRequestWatches;
    this.logger = options.logger.child({ module: "agent-stop" });
  }

  /** Stops the agent and its descendants. Only the agent's own cancellation can fail the call. */
  async stop(agentId: string): Promise<CancelAgentRunResult> {
    await this.quiesce(agentId);
    try {
      return await cancelAgentRunCommand(
        { agentManager: this.agentManager, logger: this.logger },
        agentId,
      );
    } finally {
      await this.stopDescendants(agentId);
    }
  }

  /** Refuses a call made by a run that Stop already reached; a later run may make it. */
  assertRunNotStopped(agentId: string, action: StoppedRunAction): void {
    if (!this.stoppedRuns.has(agentId)) return;
    const stoppedRunKey = this.stoppedRuns.get(agentId);
    const currentRunKey = this.agentManager.getActiveRun(agentId)?.key ?? null;
    if (currentRunKey === null || currentRunKey === stoppedRunKey) {
      throw new AgentRunStoppedError(agentId, action);
    }
  }

  private async quiesce(agentId: string): Promise<void> {
    this.stoppedRuns.set(agentId, this.agentManager.getActiveRun(agentId)?.key ?? null);
    await this.agentManager.messageQueue.hold(agentId, "user_stop");
    await this.delegations?.stopAll(agentId);
    await this.pullRequestWatches?.disposeForAgent(agentId);
  }

  /** Depth-first over live descendants; one that fails to stop does not shield the rest. */
  private async stopDescendants(rootId: string): Promise<void> {
    const childrenByParent = await this.liveChildrenByParent();
    const visited = new Set([rootId]);
    const pending = (childrenByParent.get(rootId) ?? []).toReversed();
    for (let agentId = pending.pop(); agentId !== undefined; agentId = pending.pop()) {
      if (visited.has(agentId)) continue;
      visited.add(agentId);
      await this.stopDescendant(agentId);
      pending.push(...(childrenByParent.get(agentId) ?? []).toReversed());
    }
  }

  private async stopDescendant(agentId: string): Promise<void> {
    try {
      await this.quiesce(agentId);
      if (this.agentManager.getAgent(agentId)) {
        await cancelAgentRunCommand(
          { agentManager: this.agentManager, logger: this.logger },
          agentId,
        );
      }
      this.logger.info({ agentId }, "agent.stop.descendant_stopped");
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "agent.stop.descendant_failed");
    }
  }

  private async liveChildrenByParent(): Promise<Map<string, string[]>> {
    const childrenByParent = new Map<string, string[]>();
    for (const record of await this.agentStorage.list()) {
      const parentId = getParentAgentIdFromLabels(record.labels);
      if (!parentId || record.archivedAt) continue;
      childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), record.id]);
    }
    return childrenByParent;
  }
}
