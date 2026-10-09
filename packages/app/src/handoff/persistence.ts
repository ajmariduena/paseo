import { z } from "zod";
import { HandoffDestinationSnapshotSchema } from "@getpaseo/protocol/handoff-control";
import type {
  HandoffDestinationSnapshot,
  HandoffCancellationProof,
  HandoffSourceSnapshot,
} from "@getpaseo/protocol/handoff-control";

export interface HandoffOrigin {
  sourceServerId: string;
  workspaceId: string;
}

const HandoffRecordSchema = z.object({
  version: z.literal(1),
  transferId: z.string().uuid(),
  sourceServerId: z.string().min(1),
  workspaceId: z.string().min(1),
  destinationServerId: z.string().min(1),
  destinationLabel: z.string().min(1),
  destinationParent: z.string().min(1),
  continuationMode: z.enum(["native", "context"]),
  reviewedAgentIds: z.array(z.string().min(1)).max(1000).optional(),
  intent: z.enum(["prepare", "activate", "cancel"]),
  snapshot: HandoffDestinationSnapshotSchema.nullable(),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

export function restoreHandoffRecord(input: {
  origin: HandoffOrigin;
  source: HandoffSourceSnapshot["source"];
  destination: { serverId: string; label: string };
  snapshot: HandoffDestinationSnapshot;
}): HandoffRecord {
  const { origin, source, destination, snapshot } = input;
  const destinationReleased = ["released", "activating", "active"].includes(snapshot.state);
  if (
    source.workspaceId !== origin.workspaceId ||
    source.destinationServerId !== destination.serverId ||
    destination.serverId === origin.sourceServerId ||
    snapshot.sourceServerId !== origin.sourceServerId ||
    snapshot.sourceWorkspaceId !== origin.workspaceId ||
    snapshot.transferId !== source.id ||
    snapshot.reservationId !== source.reservationId ||
    JSON.stringify([...snapshot.sourceAgentIds].sort()) !==
      JSON.stringify([...source.agentIds].sort()) ||
    (snapshot.manifestDigest !== null && snapshot.manifestDigest !== source.manifestDigest) ||
    (snapshot.state === "cancelled" && source.state !== "cancelled") ||
    (destinationReleased && source.state !== "released") ||
    (source.state === "released" && snapshot.state !== "staged" && !destinationReleased)
  )
    throw new Error("Source and destination handoff records do not match");
  const intents = {
    cancelled: "cancel",
    released: "activate",
    ready: "prepare",
    preparing: "prepare",
  } as const;
  const intent = intents[source.state];
  return restoredRecord(origin, destination, snapshot, intent);
}

export function restoreReservedHandoffRecord(input: {
  origin: HandoffOrigin;
  destination: { serverId: string; label: string };
  snapshot: HandoffDestinationSnapshot;
}): HandoffRecord {
  const { origin, destination, snapshot } = input;
  if (
    destination.serverId === origin.sourceServerId ||
    snapshot.sourceServerId !== origin.sourceServerId ||
    snapshot.sourceWorkspaceId !== origin.workspaceId ||
    snapshot.state !== "reserved"
  )
    throw new Error("Destination reservation does not match this workspace");
  return restoredRecord(origin, destination, snapshot, "prepare");
}

export function restoreCancelledHandoffRecord(input: {
  origin: HandoffOrigin;
  destination: { serverId: string; label: string };
  snapshot: HandoffDestinationSnapshot;
  proof?: HandoffCancellationProof;
}): HandoffRecord {
  const { origin, destination, snapshot, proof } = input;
  if (
    destination.serverId === origin.sourceServerId ||
    snapshot.sourceServerId !== origin.sourceServerId ||
    snapshot.sourceWorkspaceId !== origin.workspaceId ||
    ["released", "activating", "active"].includes(snapshot.state)
  )
    throw new Error("Cancellation belongs to a different workspace or released transfer");
  if (proof) {
    const receipt = proof.receipt;
    if (
      receipt.sourceServerId !== origin.sourceServerId ||
      receipt.destinationServerId !== destination.serverId ||
      receipt.transferId !== snapshot.transferId ||
      receipt.reservationId !== snapshot.reservationId
    )
      throw new Error("Cancellation does not match the destination reservation");
  } else if (snapshot.state !== "cancelled") {
    throw new Error("Source cancellation has not been confirmed");
  }
  return restoredRecord(origin, destination, snapshot, "cancel");
}

export function isHandoffCancellationComplete(
  snapshot: HandoffDestinationSnapshot | null,
): boolean {
  return snapshot?.state === "cancelled" && snapshot.cleanupComplete === true;
}

function restoredRecord(
  origin: HandoffOrigin,
  destination: { serverId: string; label: string },
  snapshot: HandoffDestinationSnapshot,
  intent: HandoffRecord["intent"],
): HandoffRecord {
  return {
    version: 1,
    ...origin,
    transferId: snapshot.transferId,
    destinationServerId: destination.serverId,
    destinationLabel: destination.label,
    destinationParent: snapshot.destinationParent,
    continuationMode: snapshot.continuationMode,
    reviewedAgentIds: snapshot.sourceAgentIds,
    intent,
    snapshot,
  };
}

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function storageKey(origin: HandoffOrigin): string {
  return `paseo:workspace-handoff:${JSON.stringify([origin.sourceServerId, origin.workspaceId])}`;
}

/** Unlike preference persistence, failures must reach the form before it starts host mutations. */
export function createHandoffPersistence(storage: Storage) {
  return {
    async load(origin: HandoffOrigin): Promise<HandoffRecord | null> {
      const raw = await storage.getItem(storageKey(origin));
      if (raw === null) return null;
      const record = HandoffRecordSchema.parse(JSON.parse(raw));
      const matchesOrigin =
        record.sourceServerId === origin.sourceServerId &&
        record.workspaceId === origin.workspaceId;
      if (!matchesOrigin || record.destinationServerId === origin.sourceServerId) {
        throw new Error("Saved handoff belongs to a different workspace or host");
      }
      const snapshot = record.snapshot;
      if (
        snapshot &&
        (snapshot.transferId !== record.transferId ||
          snapshot.sourceServerId !== record.sourceServerId ||
          snapshot.sourceWorkspaceId !== record.workspaceId ||
          snapshot.continuationMode !== record.continuationMode)
      )
        throw new Error("Saved handoff destination does not match the transfer");
      return record;
    },
    async save(record: HandoffRecord): Promise<void> {
      await storage.setItem(storageKey(record), JSON.stringify(record));
    },
    async discard(origin: HandoffOrigin): Promise<void> {
      await storage.removeItem(storageKey(origin));
    },
  };
}
