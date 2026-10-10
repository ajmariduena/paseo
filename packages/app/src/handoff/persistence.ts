import { z } from "zod";
import {
  handoffReviewsMatch,
  handoffContinuationsMatch,
  assertHandoffCheckpointMatches,
} from "@getpaseo/client/internal/workspace-handoff";
import {
  HandoffDestinationSnapshotSchema,
  HandoffStoppedWorkReviewSchema,
  HandoffIntegrationReviewSchema,
  HandoffConversationModesSchema,
} from "@getpaseo/protocol/handoff-control";
import { HandoffDigestSchema } from "@getpaseo/protocol/handoff";
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
  conversationModes: HandoffConversationModesSchema.optional(),
  reviewedAgentIds: z.array(z.string().min(1)).max(1000).optional(),
  workspaceReviewDigest: HandoffDigestSchema.optional(),
  stoppedWorkReview: HandoffStoppedWorkReviewSchema.optional(),
  integrationReview: HandoffIntegrationReviewSchema.optional(),
  intent: z.enum(["prepare", "activate", "cancel"]),
  sourcePublicKey: z.string().min(1).max(1024).optional(),
  snapshot: HandoffDestinationSnapshotSchema.nullable(),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

function sourceKeyMatches(actual: string | undefined, expected: string) {
  return actual === undefined || actual === expected;
}

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
    !sourceKeyMatches(snapshot.sourcePublicKey, source.publicKey) ||
    !handoffReviewsMatch(snapshot, source) ||
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
  return {
    ...restoredRecord(origin, destination, snapshot, intent),
    sourcePublicKey: source.publicKey,
  };
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

/** The authenticated destination owns the verified release receipt in these states. */
export function restoreReleasedHandoffRecord(input: {
  origin: HandoffOrigin;
  destination: { serverId: string; label: string };
  snapshot: HandoffDestinationSnapshot;
}): HandoffRecord {
  const { origin, destination, snapshot } = input;
  if (
    destination.serverId === origin.sourceServerId ||
    snapshot.sourceServerId !== origin.sourceServerId ||
    snapshot.sourceWorkspaceId !== origin.workspaceId ||
    !["released", "activating", "active"].includes(snapshot.state) ||
    !snapshot.manifestDigest
  )
    throw new Error("Destination has not accepted this workspace's release");
  return restoredRecord(origin, destination, snapshot, "activate");
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
    if (snapshot.sourcePublicKey !== undefined && snapshot.sourcePublicKey !== proof.publicKey)
      throw new Error("Cancellation signing key does not match the destination reservation");
  } else if (snapshot.state !== "cancelled") {
    throw new Error("Source cancellation has not been confirmed");
  }
  return {
    ...restoredRecord(origin, destination, snapshot, "cancel"),
    sourcePublicKey: proof?.publicKey ?? snapshot.sourcePublicKey,
  };
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
    conversationModes: snapshot.conversationModes,
    reviewedAgentIds: snapshot.sourceAgentIds,
    workspaceReviewDigest: snapshot.workspaceReviewDigest,
    stoppedWorkReview: snapshot.stoppedWorkReview,
    integrationReview: snapshot.integrationReview,
    intent,
    sourcePublicKey: snapshot.sourcePublicKey,
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
  const writes = new Map<string, Promise<void>>();
  async function serialize(origin: HandoffOrigin, operation: () => Promise<void>) {
    const key = storageKey(origin);
    const previous = writes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    writes.set(key, current);
    try {
      await current;
    } finally {
      if (writes.get(key) === current) writes.delete(key);
    }
  }
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
          (record.sourcePublicKey !== undefined &&
            snapshot.sourcePublicKey !== undefined &&
            snapshot.sourcePublicKey !== record.sourcePublicKey) ||
          !handoffContinuationsMatch(snapshot, record) ||
          !handoffReviewsMatch(snapshot, record))
      )
        throw new Error("Saved handoff destination does not match the transfer");
      return record;
    },
    async save(record: HandoffRecord): Promise<void> {
      await serialize(record, async () => {
        const key = storageKey(record);
        const raw = await storage.getItem(key);
        const previous = raw === null ? null : HandoffRecordSchema.parse(JSON.parse(raw));
        let candidate = record;
        if (previous?.transferId === record.transferId) {
          candidate = {
            ...record,
            sourcePublicKey:
              record.sourcePublicKey ??
              record.snapshot?.sourcePublicKey ??
              previous.sourcePublicKey ??
              previous.snapshot?.sourcePublicKey,
          };
          assertHandoffCheckpointMatches(previous, candidate);
        }
        await storage.setItem(key, JSON.stringify(candidate));
      });
    },
    async discard(origin: HandoffOrigin): Promise<void> {
      await serialize(origin, () => storage.removeItem(storageKey(origin)));
    },
  };
}
