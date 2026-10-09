import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type {
  AgentStorage,
  RestartCancelledWork,
  StoredAgentRecord,
} from "../agent/agent-storage.js";
import { dispatchAgentMessage, type MessageDisposition } from "../agent/message-dispatch.js";
import type { DelegationService } from "../delegation/delegation-service.js";
import type { MessageReceipts } from "../message-receipts/index.js";
import { activeIncarnation, hasUnsettledSwitch } from "../agent/provider-switch/record.js";
import { cancelledWorkFromTasks, restartCancelledWorkNote } from "./background-note.js";
import type { CutRun, RestartIntentStore } from "./restart-intent-store.js";

const CONTINUE_PROMPT = "Continue where you left off.";
const CUT_STATUSES = new Set(["running", "initializing"]);

export type ContinuationDeclineReason =
  | "disabled"
  | "missing"
  | "archived"
  | "provider_changed"
  | "newer_prompt"
  | "stop_requested"
  | "out_of_band"
  | "no_persistence"
  | "switch_pending"
  | "unresolved_attempt";

export type ContinuationDecision =
  | { continue: true }
  | { continue: false; reason: ContinuationDeclineReason };

/** Port of T3 `continueRestartedRun`'s decline checks, over what Paseo keeps across a restart. */
export function decideContinuation(input: {
  enabled: boolean;
  cut: CutRun;
  record: StoredAgentRecord | null;
}): ContinuationDecision {
  const { enabled, cut, record } = input;
  if (!enabled) return { continue: false, reason: "disabled" };
  if (!record) return { continue: false, reason: "missing" };
  if (record.archivedAt) return { continue: false, reason: "archived" };
  if (record.provider !== cut.provider) return { continue: false, reason: "provider_changed" };
  if (record.lastUserMessageAt && record.lastUserMessageAt > cut.cutAt) {
    return { continue: false, reason: "newer_prompt" };
  }
  if (cut.stopRequested) return { continue: false, reason: "stop_requested" };
  if (cut.outOfBand) return { continue: false, reason: "out_of_band" };
  if (hasUnsettledSwitch(record)) return { continue: false, reason: "switch_pending" };
  if (activeIncarnation(record)?.unresolvedAttemptId) {
    return { continue: false, reason: "unresolved_attempt" };
  }
  if (!record.persistence) return { continue: false, reason: "no_persistence" };
  return { continue: true };
}

export function restartContinuationMessageId(cut: CutRun): string {
  return `restart-continuation:${cut.agentId}:${cut.runKey}`;
}

export interface RestartRecoveryResult {
  /** Continuations load and start agents, so they finish after boot; this settles when they have. */
  continuations: Promise<void>;
}

export interface RestartRecoveryOptions {
  intents: RestartIntentStore;
  receipts: Pick<MessageReceipts, "send">;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  delegations: Pick<
    DelegationService,
    "recoverAfterRestart" | "adoptContinuedChild" | "reportCutChild"
  >;
  continueAfterRestart(): boolean;
  logger: Logger;
}

/**
 * Restart semantics in one place: what a shutdown cut short is written down while providers
 * are live, and the next boot holds every surviving queue, settles delegations the restart
 * interrupted, and continues cut turns when the setting allows. Run keys do not survive a
 * restart, so after boot nothing counts as live.
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
    const backgroundWork: Record<string, RestartCancelledWork[]> = {};
    for (const agent of agentManager.listAgents()) {
      if (agent.backgroundTasks.length > 0) {
        backgroundWork[agent.id] = cancelledWorkFromTasks(agent.backgroundTasks);
      }
      const run = agentManager.getActiveRun(agent.id);
      if (!run && !CUT_STATUSES.has(agent.lifecycle)) continue;
      cutRuns.push({
        agentId: agent.id,
        provider: agent.provider,
        runKey: run?.key ?? "pending",
        cutAt,
        stopRequested: agentManager.isStopRequested(agent.id),
        outOfBand: agentManager.hasOutOfBandInFlight(agent.id),
      });
    }
    await intents.write({ version: 1, writtenAt: cutAt, cutRuns, backgroundWork });
    this.logger.info({ cutRuns: cutRuns.length }, "restart.intents_written");
  }

  /** Boot, before clients connect: nothing queued before the restart goes out on its own. */
  async holdQueues(): Promise<void> {
    await this.options.agentManager.messageQueue.holdAllForRestart();
  }

  /**
   * Boot, once providers are ready. Settled agents that lost background work stay asleep and
   * hear about it on their next turn; cut turns continue only when the setting is on.
   */
  async recoverAfterRestart(): Promise<RestartRecoveryResult> {
    const { agentStorage, delegations, intents } = this.options;
    const intentFile = await intents.read();
    const records = new Map((await agentStorage.list()).map((record) => [record.id, record]));
    const cutRuns = withCrashCutRuns(intentFile?.cutRuns ?? [], records.values());
    const enabled = this.options.continueAfterRestart();
    const continuing: CutRun[] = [];
    for (const cut of cutRuns) {
      const decision = decideContinuation({
        enabled,
        cut,
        record: records.get(cut.agentId) ?? null,
      });
      this.logger.info({ agentId: cut.agentId, decision }, "restart.continuation_decided");
      if (decision.continue) continuing.push(cut);
    }
    const continuingIds = new Set(continuing.map((cut) => cut.agentId));
    const backgroundWork = intentFile?.backgroundWork ?? {};
    for (const [agentId, work] of Object.entries(backgroundWork)) {
      if (!continuingIds.has(agentId)) await this.rememberLostWork(agentId, work);
    }
    await delegations.recoverAfterRestart({
      cut: new Set(cutRuns.map((cut) => cut.agentId)),
      continuing: continuingIds,
    });
    await intents.delete();
    const continuations = Promise.all(
      continuing.map((cut) => this.continueRun(cut, backgroundWork[cut.agentId] ?? [])),
    ).then(() => undefined);
    return { continuations };
  }

  /**
   * One "Continue where you left off." per cut run: the receipt under its stable id makes a
   * repeated boot a no-op. A child the continuation does not resume still reports to its parent.
   */
  private async continueRun(cut: CutRun, lostWork: RestartCancelledWork[]): Promise<void> {
    const agentId = cut.agentId;
    const outcome = await this.dispatchContinuation(cut, lostWork).catch((error: unknown) => {
      this.logger.warn({ err: error, agentId }, "restart.continuation_failed");
      return "dropped" as const;
    });
    this.logger.info({ agentId, outcome }, "restart.continuation_dispatched");
    if (outcome === "started" || outcome === "already_sent") {
      this.options.delegations.adoptContinuedChild(agentId);
      return;
    }
    await this.rememberLostWork(agentId, lostWork);
    await this.options.delegations.reportCutChild(agentId);
  }

  private async dispatchContinuation(
    cut: CutRun,
    lostWork: RestartCancelledWork[],
  ): Promise<MessageDisposition | "already_sent"> {
    const { agentManager, agentStorage, receipts, logger } = this.options;
    const agentId = cut.agentId;
    const messageId = restartContinuationMessageId(cut);
    const sent: { disposition: MessageDisposition | "already_sent" } = {
      disposition: "already_sent",
    };
    await receipts.send({
      agentId,
      messageId,
      request: { kind: "restart_continuation", runKey: cut.runKey },
      prepare: async () => {
        await ensureAgentLoaded(agentId, { agentManager, agentStorage, logger });
      },
      send: async () => {
        // Anything that started the agent since boot came after the cut and takes precedence.
        if (agentManager.getActiveRun(agentId)) {
          sent.disposition = "dropped";
          return;
        }
        sent.disposition = await dispatchAgentMessage({
          agentManager,
          agentStorage,
          agentId,
          messageId,
          policy: {
            kind: "system",
            maySteer: false,
            queueAs: { origin: "system" },
            prepare: async () => ({
              prompt:
                lostWork.length > 0
                  ? `${restartCancelledWorkNote(lostWork)}\n\n${CONTINUE_PROMPT}`
                  : CONTINUE_PROMPT,
              notification: { level: "info", message: "Continued after the daemon restarted" },
            }),
          },
          logger,
        });
      },
    });
    return sent.disposition;
  }

  private async rememberLostWork(agentId: string, work: RestartCancelledWork[]): Promise<void> {
    if (work.length === 0) return;
    try {
      await this.options.agentStorage.addPendingRestartNote(agentId, work);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "restart.background_note_failed");
    }
  }
}

/** After a crash no intents exist, but the records of agents that were mid-turn still say so. */
function withCrashCutRuns(
  cutRuns: readonly CutRun[],
  records: Iterable<StoredAgentRecord>,
): CutRun[] {
  const merged = [...cutRuns];
  for (const record of records) {
    const recorded = merged.some((cut) => cut.agentId === record.id);
    if (recorded || !CUT_STATUSES.has(record.lastStatus)) continue;
    merged.push({
      agentId: record.id,
      provider: record.provider,
      runKey: `crash:${record.updatedAt}`,
      cutAt: record.updatedAt,
      stopRequested: false,
      outOfBand: false,
    });
  }
  return merged;
}
