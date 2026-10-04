import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DelegationService } from "../delegation/delegation-service.js";
import type { CutRun, RestartIntentStore } from "./restart-intent-store.js";

export interface RestartRecoveryOptions {
  intents: RestartIntentStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  delegations: Pick<DelegationService, "recoverAfterRestart">;
  logger: Logger;
}

const CUT_STATUSES = new Set(["running", "initializing"]);

/**
 * Restart semantics in one place: what a shutdown cut short is written down while providers
 * are live, and the next boot holds every surviving queue and settles delegations the restart
 * interrupted. Run keys do not survive a restart, so after boot nothing counts as live.
 */
export class RestartRecovery {
  private readonly logger: Logger;

  constructor(private readonly options: RestartRecoveryOptions) {
    this.logger = options.logger.child({ module: "restart-recovery" });
  }

  /** Call after ingress is frozen and before agents close, while their runs are still visible. */
  async prepareForShutdown(): Promise<void> {
    const { agentManager, intents } = this.options;
    const cutAt = new Date().toISOString();
    const cutRuns: CutRun[] = [];
    for (const agent of agentManager.listAgents()) {
      const run = agentManager.getActiveRun(agent.id);
      if (!run && !CUT_STATUSES.has(agent.lifecycle)) continue;
      cutRuns.push({
        agentId: agent.id,
        provider: agent.provider,
        runKey: run?.key ?? "pending",
        cutAt,
      });
    }
    await intents.write({ version: 1, writtenAt: cutAt, cutRuns });
    this.logger.info({ cutRuns: cutRuns.length }, "restart.intents_written");
  }

  /** Boot, before clients connect: nothing queued before the restart goes out on its own. */
  async holdQueues(): Promise<void> {
    await this.options.agentManager.messageQueue.holdAllForRestart();
  }

  /** Boot, once providers are ready: delegations the restart interrupted report back. */
  async recoverDelegations(): Promise<void> {
    const cut = await this.cutAgentIds();
    await this.options.delegations.recoverAfterRestart(cut);
    await this.options.intents.delete();
  }

  /** A graceful shutdown names its cut runs; after a crash the agent records still say running. */
  private async cutAgentIds(): Promise<Set<string>> {
    const intents = await this.options.intents.read();
    const cut = new Set(intents?.cutRuns.map((run) => run.agentId) ?? []);
    for (const record of await this.options.agentStorage.list()) {
      if (CUT_STATUSES.has(record.lastStatus)) cut.add(record.id);
    }
    return cut;
  }
}
