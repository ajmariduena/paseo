import { z } from "zod";
import { HandoffDestinationSnapshotSchema } from "@getpaseo/protocol/handoff-control";

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
  intent: z.enum(["prepare", "activate", "cancel"]),
  snapshot: HandoffDestinationSnapshotSchema.nullable(),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
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
  };
}
