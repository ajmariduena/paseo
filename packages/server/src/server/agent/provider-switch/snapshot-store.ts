import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../../atomic-file.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { ProviderSubagentDescriptor } from "../provider-subagents/store.js";

export const SNAPSHOT_BYTE_CAP = 8 * 1024 * 1024;
export const CHILD_PANE_BYTE_CAP = 512 * 1024;
export const CHILD_PANE_COUNT_CAP = 32;

const RowIdentitySchema = z.object({
  segmentId: z.string(),
  incarnationId: z.string(),
  rowIndex: z.number().int().nonnegative(),
});

const SnapshotRowSchema = z.object({
  identity: RowIdentitySchema,
  timestamp: z.string(),
  item: z.custom<AgentTimelineItem>((value) => typeof value === "object" && value !== null),
  turnId: z.string().optional(),
});

const RowRangeSchema = z.object({
  fromRowIndex: z.number().int().nonnegative(),
  toRowIndex: z.number().int().nonnegative(),
});

const ChildPaneSchema = z.object({
  descriptor: z.custom<ProviderSubagentDescriptor>(
    (value) => typeof value === "object" && value !== null,
  ),
  /** Null when only the descriptor survived the caps. */
  rows: z.array(SnapshotRowSchema).nullable(),
  droppedRanges: z.array(RowRangeSchema),
});

export const SegmentSnapshotSchema = z.object({
  version: z.literal(1),
  agentId: z.string(),
  segmentId: z.string(),
  incarnationId: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  sealedAt: z.string(),
  rows: z.array(SnapshotRowSchema),
  childPanes: z.array(ChildPaneSchema),
  childPanesNotice: z.enum(["too_many", "over_cap"]).nullable(),
  coverage: z.enum(["complete", "truncated"]),
  droppedRanges: z.array(RowRangeSchema),
});

export type SegmentSnapshot = z.infer<typeof SegmentSnapshotSchema>;
export type SnapshotRow = z.infer<typeof SnapshotRowSchema>;
export type SnapshotRowIdentity = z.infer<typeof RowIdentitySchema>;
export type SnapshotRowRange = z.infer<typeof RowRangeSchema>;

export interface ChildPaneInput {
  descriptor: ProviderSubagentDescriptor;
  rows: readonly AgentTimelineRow[];
}

export interface SealSnapshotInput {
  agentId: string;
  segmentId: string;
  incarnationId: string;
  provider: string;
  model: string | null;
  rows: readonly AgentTimelineRow[];
  childPanes: readonly ChildPaneInput[];
  sealedAt: string;
}

export class SnapshotAlreadySealedError extends Error {
  constructor(
    readonly agentId: string,
    readonly incarnationId: string,
  ) {
    super(`Snapshot ${incarnationId} of agent ${agentId} is already sealed`);
    this.name = "SnapshotAlreadySealedError";
  }
}

/** Prefix provider-native ids so a retired incarnation's rows never merge with live ones. */
function namespaceItem(item: AgentTimelineItem, incarnationId: string): AgentTimelineItem {
  const prefix = `${incarnationId}:`;
  if (item.type === "tool_call") {
    return { ...item, callId: `${prefix}${item.callId}` };
  }
  if (item.type === "plugin") {
    return { ...item, id: `${prefix}${item.id}` };
  }
  if (
    (item.type === "user_message" || item.type === "assistant_message") &&
    item.messageId !== undefined
  ) {
    return { ...item, messageId: `${prefix}${item.messageId}` };
  }
  return item;
}

function toSnapshotRows(
  rows: readonly AgentTimelineRow[],
  identity: { segmentId: string; incarnationId: string },
): SnapshotRow[] {
  return rows.map((row, rowIndex) => ({
    identity: { ...identity, rowIndex },
    timestamp: row.timestamp,
    item: namespaceItem(row.item, identity.incarnationId),
    ...(row.turnId ? { turnId: row.turnId } : {}),
  }));
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

interface Trimmed {
  rows: SnapshotRow[];
  droppedRanges: SnapshotRowRange[];
}

/** Drops the oldest rows until the serialized rows fit the cap; indices stay as sealed. */
function trimOldest(rows: readonly SnapshotRow[], cap: number): Trimmed {
  let total = rows.reduce((sum, row) => sum + byteSize(row), 0);
  let dropped = 0;
  while (total > cap && dropped < rows.length) {
    total -= byteSize(rows[dropped]);
    dropped += 1;
  }
  const kept = rows.slice(dropped);
  const droppedRanges: SnapshotRowRange[] =
    dropped > 0 ? [{ fromRowIndex: 0, toRowIndex: dropped - 1 }] : [];
  return { rows: kept, droppedRanges };
}

function buildChildPanes(
  input: SealSnapshotInput,
): Pick<SegmentSnapshot, "childPanes" | "childPanesNotice"> {
  const identity = { segmentId: input.segmentId, incarnationId: input.incarnationId };
  const panes = input.childPanes.map((pane, index) => {
    if (index >= CHILD_PANE_COUNT_CAP) {
      return { descriptor: pane.descriptor, rows: null, droppedRanges: [] };
    }
    const trimmed = trimOldest(toSnapshotRows(pane.rows, identity), CHILD_PANE_BYTE_CAP);
    return { descriptor: pane.descriptor, ...trimmed };
  });
  const notice = input.childPanes.length > CHILD_PANE_COUNT_CAP ? ("too_many" as const) : null;
  return { childPanes: panes, childPanesNotice: notice };
}

/** Applies the seal-time caps. Pure, so the same input always seals the same file. */
export function buildSegmentSnapshot(input: SealSnapshotInput): SegmentSnapshot {
  const identity = { segmentId: input.segmentId, incarnationId: input.incarnationId };
  const rows = toSnapshotRows(input.rows, identity);
  let snapshot: SegmentSnapshot = {
    version: 1,
    agentId: input.agentId,
    segmentId: input.segmentId,
    incarnationId: input.incarnationId,
    provider: input.provider,
    model: input.model,
    sealedAt: input.sealedAt,
    rows,
    ...buildChildPanes(input),
    coverage: "complete",
    droppedRanges: [],
  };
  if (byteSize(snapshot) <= SNAPSHOT_BYTE_CAP) {
    return snapshot;
  }
  // Child panes go first: the parent transcript is what the handoff and the chat read.
  snapshot = {
    ...snapshot,
    childPanes: snapshot.childPanes.map((pane) => ({ ...pane, rows: null, droppedRanges: [] })),
    childPanesNotice: "over_cap",
  };
  if (byteSize(snapshot) <= SNAPSHOT_BYTE_CAP) {
    return snapshot;
  }
  const overhead = byteSize({ ...snapshot, rows: [] });
  const trimmed = trimOldest(rows, SNAPSHOT_BYTE_CAP - overhead);
  return {
    ...snapshot,
    rows: trimmed.rows,
    droppedRanges: trimmed.droppedRanges,
    coverage: trimmed.droppedRanges.length > 0 ? "truncated" : "complete",
  };
}

/**
 * Sealed retired history: `{directory}/{agentId}/{incarnationId}.json`, written once and never
 * rewritten. Every method is one atomic write or one read.
 */
export class SegmentSnapshotStore {
  constructor(private readonly directory: string) {}

  async seal(input: SealSnapshotInput): Promise<SegmentSnapshot> {
    const filePath = this.filePath(input.agentId, input.incarnationId);
    if (await exists(filePath)) {
      throw new SnapshotAlreadySealedError(input.agentId, input.incarnationId);
    }
    const snapshot = buildSegmentSnapshot(input);
    await writeJsonFileAtomic(filePath, snapshot);
    return snapshot;
  }

  async read(agentId: string, incarnationId: string): Promise<SegmentSnapshot | null> {
    const raw = await readJson(this.filePath(agentId, incarnationId));
    return raw === null ? null : SegmentSnapshotSchema.parse(raw);
  }

  async listIncarnations(agentId: string): Promise<string[]> {
    return (await listJsonNames(path.join(this.directory, agentId))).sort();
  }

  async listAgents(): Promise<string[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async delete(agentId: string, incarnationId: string): Promise<void> {
    await rm(this.filePath(agentId, incarnationId), { force: true });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await rm(path.join(this.directory, agentId), { recursive: true, force: true });
  }

  private filePath(agentId: string, incarnationId: string): string {
    return path.join(this.directory, agentId, `${incarnationId}.json`);
  }
}

export async function listJsonNames(directory: string): Promise<string[]> {
  try {
    const names = await readdir(directory);
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
