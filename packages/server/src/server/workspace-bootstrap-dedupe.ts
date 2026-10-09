import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

/**
 * Pure dedupe decision for the bootstrap flush.
 *
 * During the bootstrap window the session buffers workspace updates that
 * race with the initial `fetch_workspaces_response`. The flush step decides
 * which buffered updates still carry new information and which are
 * redundant with what the client just received in the snapshot.
 *
 * Ownership changes do not necessarily advance agent activity. Keep them
 * alongside status changes when deciding whether a buffered update is new.
 */
export interface BootstrapUpdateSnapshot {
  status: string;
  statusEnteredAt: string | null;
  activityAtMs: number | null;
  waitingOnSubagentsCount?: number;
  delegatedByAgentId?: string;
  handoff?: WorkspaceDescriptorPayload["handoff"];
}

export interface BootstrapUpdateCheckInput {
  /** Snapshot captured from the fetch_workspaces_response. `null` means
   * the workspace was not in the snapshot (first-time subscription). */
  snapshot: BootstrapUpdateSnapshot | null;
  /** Pending update buffered during the bootstrap window. */
  update: BootstrapUpdateSnapshot;
}

export function shouldEmitPendingBootstrapUpdate(input: BootstrapUpdateCheckInput): boolean {
  const { snapshot, update } = input;
  if (!snapshot) {
    return true;
  }

  if (snapshot.status !== update.status) {
    return true;
  }
  if ((snapshot.waitingOnSubagentsCount ?? 0) !== (update.waitingOnSubagentsCount ?? 0)) {
    return true;
  }
  if (snapshot.delegatedByAgentId !== update.delegatedByAgentId) {
    return true;
  }
  // Ownership can change without any agent activity or bucket transition.
  if (handoffChanged(snapshot.handoff, update.handoff)) return true;

  const snapshotEnteredAt = snapshot.statusEnteredAt ?? null;
  const updateEnteredAt = update.statusEnteredAt ?? null;
  if (snapshotEnteredAt !== updateEnteredAt) {
    return true;
  }

  // Status pair is unchanged. The only remaining signal is activity.
  if (update.activityAtMs === null) {
    return false;
  }
  if (snapshot.activityAtMs === null) {
    return true;
  }
  return update.activityAtMs > snapshot.activityAtMs;
}

function handoffChanged(
  left: BootstrapUpdateSnapshot["handoff"],
  right: BootstrapUpdateSnapshot["handoff"],
): boolean {
  return (
    left?.transferId !== right?.transferId ||
    left?.state !== right?.state ||
    left?.destinationServerId !== right?.destinationServerId
  );
}
