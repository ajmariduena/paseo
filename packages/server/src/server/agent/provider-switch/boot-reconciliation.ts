import type { Logger } from "pino";

import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import type { HandoffStore } from "./handoff-store.js";
import {
  SETTLED_SWITCH_PHASES,
  type ProviderSwitchRecordState,
  type SwitchOperation,
} from "./record.js";
import type { SegmentSnapshotStore } from "./snapshot-store.js";

export interface BootReconciliationDeps {
  storage: Pick<AgentStorage, "list" | "mutateProviderSwitchState">;
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
  orphanSnapshots: Array<{ agentId: string; incarnationId: string }>;
  orphanHandoffs: Array<{ agentId: string; handoffId: string }>;
}

function phaseAfterRestart(operation: SwitchOperation): SwitchOperation["phase"] {
  // Only a committed record has a target the agent can run on; everything before it left the
  // source active with its handle, so the operation is over and retryable from scratch.
  return operation.phase === "committed" ? "done" : "failed";
}

function reconcileOperations(
  state: ProviderSwitchRecordState,
  now: string,
): { state: ProviderSwitchRecordState; changed: SwitchOperation[] } {
  const changed: SwitchOperation[] = [];
  const operations: SwitchOperation[] = [];
  for (const operation of state.switchOperations ?? []) {
    if (SETTLED_SWITCH_PHASES.has(operation.phase)) {
      operations.push(operation);
      continue;
    }
    const phase = phaseAfterRestart(operation);
    const error =
      phase === "failed" ? `Interrupted by a daemon restart while ${operation.phase}` : null;
    const next: SwitchOperation = { ...operation, phase, error, updatedAt: now };
    changed.push(next);
    operations.push(next);
  }
  return { state: { ...state, switchOperations: operations }, changed };
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

/**
 * Boot, before any sender dispatches: settles every switch operation a restart cut and sweeps
 * snapshot and handoff files nothing references. Each record change is one atomic write.
 * Nothing here loads an agent or sends a prompt.
 */
export async function reconcileProviderSwitchesAtBoot(
  deps: BootReconciliationDeps,
): Promise<BootReconciliationSummary> {
  const summary: BootReconciliationSummary = {
    failed: [],
    completed: [],
    orphanSnapshots: [],
    orphanHandoffs: [],
  };
  const records = new Map<string, StoredAgentRecord>();
  for (const record of await deps.storage.list()) {
    records.set(record.id, record);
    const unsettled = (record.switchOperations ?? []).some(
      (operation) => !SETTLED_SWITCH_PHASES.has(operation.phase),
    );
    if (!unsettled) continue;
    const now = deps.now();
    const written = await deps.storage.mutateProviderSwitchState(record.id, (state) => {
      const reconciled = reconcileOperations(state, now);
      for (const operation of reconciled.changed) {
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
      return reconciled.state;
    });
    records.set(record.id, written);
  }
  for (const entry of summary.failed) {
    deps.logger.warn(entry, "provider_switch.operation_failed_at_boot");
  }

  for (const agentId of await deps.snapshots.listAgents()) {
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
  return summary;
}
