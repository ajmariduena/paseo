import type { Logger } from "pino";

import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import type { HandoffStore } from "./handoff-store.js";
import { SETTLED_SWITCH_PHASES, type SwitchOperation } from "./record.js";
import type { SegmentSnapshotStore } from "./snapshot-store.js";

export interface BootReconciliationDeps {
  storage: Pick<AgentStorage, "list" | "commitProviderSwitch" | "scanRecordIds">;
  snapshots: Pick<
    SegmentSnapshotStore,
    "listAgents" | "listIncarnations" | "delete" | "deleteAgent"
  >;
  handoffs: Pick<HandoffStore, "listAgents" | "list" | "delete" | "deleteAgent">;
  logger: Logger;
  now: () => string;
}

export interface BootReconciliationSummary {
  /** Operations closed as failed, with the handle a failed allocation left behind, if any. */
  failed: Array<{ agentId: string; operationId: string; phase: SwitchOperation["phase"] }>;
  completed: Array<{ agentId: string; operationId: string }>;
  /** Agents whose operation could not be written; they stay off limits until the next boot. */
  recoveryFailed: Array<{ agentId: string; error: string }>;
  /** Record files the storage could not parse; their history is never swept. */
  unreadableRecords: string[];
  sweep: "done" | "skipped_incomplete_scan" | "failed";
  orphanSnapshots: Array<{ agentId: string; incarnationId: string }>;
  orphanHandoffs: Array<{ agentId: string; handoffId: string }>;
}

function phaseAfterRestart(operation: SwitchOperation): SwitchOperation["phase"] {
  // Only a committed record has a target the agent can run on; everything before it left the
  // source active with its handle, so the operation is over and retryable from scratch.
  return operation.phase === "committed" ? "done" : "failed";
}

function reconcileOperations(
  operations: readonly SwitchOperation[],
  now: string,
): { operations: SwitchOperation[]; changed: SwitchOperation[] } {
  const changed: SwitchOperation[] = [];
  const next: SwitchOperation[] = [];
  for (const operation of operations) {
    if (SETTLED_SWITCH_PHASES.has(operation.phase)) {
      next.push(operation);
      continue;
    }
    const phase = phaseAfterRestart(operation);
    const error =
      phase === "failed" ? `Interrupted by a daemon restart while ${operation.phase}` : null;
    const settled: SwitchOperation = { ...operation, phase, error, updatedAt: now };
    changed.push(settled);
    next.push(settled);
  }
  return { operations: next, changed };
}

function referencedSnapshotIds(record: StoredAgentRecord): Set<string> {
  const ids = new Set<string>();
  for (const segment of record.providerSegments ?? []) {
    for (const incarnation of segment.incarnations) {
      if (incarnation.snapshotId) ids.add(incarnation.snapshotId);
    }
  }
  return ids;
}

function referencedHandoffIds(record: StoredAgentRecord): Set<string> {
  const ids = new Set<string>();
  for (const segment of record.providerSegments ?? []) {
    if (segment.handoffId) ids.add(segment.handoffId);
  }
  for (const operation of record.switchOperations ?? []) {
    if (operation.result?.handoffId) ids.add(operation.result.handoffId);
  }
  return ids;
}

async function settleOperations(
  deps: BootReconciliationDeps,
  records: Map<string, StoredAgentRecord>,
  summary: BootReconciliationSummary,
): Promise<void> {
  for (const record of records.values()) {
    const unsettled = (record.switchOperations ?? []).some(
      (operation) => !SETTLED_SWITCH_PHASES.has(operation.phase),
    );
    if (!unsettled) continue;
    const now = deps.now();
    let changed: SwitchOperation[] = [];
    try {
      const written = await deps.storage.commitProviderSwitch(record.id, (candidate) => {
        const reconciled = reconcileOperations(candidate.switchOperations ?? [], now);
        changed = reconciled.changed;
        return { ...candidate, switchOperations: reconciled.operations };
      });
      records.set(record.id, written);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.recoveryFailed.push({ agentId: record.id, error: message });
      deps.logger.error({ err: error, agentId: record.id }, "provider_switch.recovery_failed");
      continue;
    }
    for (const operation of changed) {
      if (operation.phase === "done") {
        summary.completed.push({ agentId: record.id, operationId: operation.operationId });
      } else {
        summary.failed.push({
          agentId: record.id,
          operationId: operation.operationId,
          phase: operation.phase,
        });
      }
    }
  }
}

async function sweepOrphans(
  deps: BootReconciliationDeps,
  records: Map<string, StoredAgentRecord>,
  unreadable: Set<string>,
  summary: BootReconciliationSummary,
): Promise<void> {
  for (const agentId of await deps.snapshots.listAgents()) {
    if (unreadable.has(agentId)) continue;
    const record = records.get(agentId);
    if (!record) {
      for (const incarnationId of await deps.snapshots.listIncarnations(agentId)) {
        summary.orphanSnapshots.push({ agentId, incarnationId });
      }
      await deps.snapshots.deleteAgent(agentId);
      continue;
    }
    const referenced = referencedSnapshotIds(record);
    for (const incarnationId of await deps.snapshots.listIncarnations(agentId)) {
      if (referenced.has(incarnationId)) continue;
      summary.orphanSnapshots.push({ agentId, incarnationId });
      await deps.snapshots.delete(agentId, incarnationId);
    }
  }
  for (const agentId of await deps.handoffs.listAgents()) {
    if (unreadable.has(agentId)) continue;
    const record = records.get(agentId);
    if (!record) {
      for (const handoffId of await deps.handoffs.list(agentId)) {
        summary.orphanHandoffs.push({ agentId, handoffId });
      }
      await deps.handoffs.deleteAgent(agentId);
      continue;
    }
    const referenced = referencedHandoffIds(record);
    for (const handoffId of await deps.handoffs.list(agentId)) {
      if (referenced.has(handoffId)) continue;
      summary.orphanHandoffs.push({ agentId, handoffId });
      await deps.handoffs.delete(agentId, handoffId);
    }
  }
}

/**
 * Boot, before any sender dispatches: settles every switch operation a restart cut and sweeps
 * snapshot and handoff files nothing references. Each record change is one atomic write; an
 * agent whose write fails is reported for the boot barrier. Sweeping needs a complete record
 * scan and never touches an agent whose record exists but cannot be read. Nothing here loads an
 * agent or sends a prompt.
 */
export async function reconcileProviderSwitchesAtBoot(
  deps: BootReconciliationDeps,
): Promise<BootReconciliationSummary> {
  const summary: BootReconciliationSummary = {
    failed: [],
    completed: [],
    recoveryFailed: [],
    unreadableRecords: [],
    sweep: "done",
    orphanSnapshots: [],
    orphanHandoffs: [],
  };
  const records = new Map<string, StoredAgentRecord>();
  for (const record of await deps.storage.list()) {
    records.set(record.id, record);
  }
  await settleOperations(deps, records, summary);
  for (const entry of summary.failed) {
    deps.logger.warn(entry, "provider_switch.operation_failed_at_boot");
  }

  const scan = await deps.storage.scanRecordIds();
  summary.unreadableRecords = [...scan.unreadable].sort();
  if (!scan.complete) {
    summary.sweep = "skipped_incomplete_scan";
    deps.logger.warn("provider_switch.sweep_skipped_incomplete_scan");
    return summary;
  }
  try {
    await sweepOrphans(deps, records, scan.unreadable, summary);
  } catch (error) {
    summary.sweep = "failed";
    deps.logger.warn({ err: error }, "provider_switch.sweep_failed");
  }
  return summary;
}
