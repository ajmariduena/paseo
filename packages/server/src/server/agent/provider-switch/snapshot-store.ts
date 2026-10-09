import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { encodeJsonFile, writeJsonFileCreateOnce } from "../../atomic-file.js";
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

/** Measures the encoding the store writes, so caps bound the file and not a compact estimate. */
function encodedSize(value: unknown): number {
  return Buffer.byteLength(encodeJsonFile(value), "utf8");
}

interface Trimmed {
  rows: SnapshotRow[];
  droppedRanges: SnapshotRowRange[];
}

/**
 * Drops the oldest rows until `measure` fits the cap; indices stay as sealed. Size grows with
 * the row count, so the smallest sufficient drop is found by bisection over full encodings.
 */
function trimOldest(
  rows: readonly SnapshotRow[],
  cap: number,
  measure: (trimmed: Trimmed) => number,
): Trimmed {
  const trimmedBy = (dropped: number): Trimmed => ({
    rows: rows.slice(dropped),
    droppedRanges: dropped > 0 ? [{ fromRowIndex: 0, toRowIndex: dropped - 1 }] : [],
  });
  if (measure(trimmedBy(0)) <= cap) return trimmedBy(0);
  let low = 1;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (measure(trimmedBy(middle)) <= cap) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return trimmedBy(low);
}

type ChildPane = SegmentSnapshot["childPanes"][number];

function buildChildPanes(
  input: SealSnapshotInput,
): Pick<SegmentSnapshot, "childPanes" | "childPanesNotice"> {
  const identity = { segmentId: input.segmentId, incarnationId: input.incarnationId };
  const panes = input.childPanes.map((pane, index): ChildPane => {
    if (index >= CHILD_PANE_COUNT_CAP) {
      return { descriptor: pane.descriptor, rows: null, droppedRanges: [] };
    }
    const trimmed = trimOldest(
      toSnapshotRows(pane.rows, identity),
      CHILD_PANE_BYTE_CAP,
      (candidate) => encodedSize({ descriptor: pane.descriptor, ...candidate }),
    );
    return { descriptor: pane.descriptor, ...trimmed };
  });
  const notice = input.childPanes.length > CHILD_PANE_COUNT_CAP ? ("too_many" as const) : null;
  return { childPanes: panes, childPanesNotice: notice };
}

export class SnapshotTooLargeError extends Error {
  constructor(
    readonly agentId: string,
    readonly incarnationId: string,
    readonly bytes: number,
  ) {
    super(
      `Snapshot ${incarnationId} of agent ${agentId} is ${bytes} bytes with no rows left to drop`,
    );
    this.name = "SnapshotTooLargeError";
  }
}

/**
 * Applies the seal-time caps to the exact encoding that will be written. Pure, so the same input
 * always seals the same file. Child panes give way before the parent transcript: first their
 * rows, then their descriptors; only then are the oldest parent rows dropped.
 */
export function buildSegmentSnapshot(input: SealSnapshotInput): SegmentSnapshot {
  const identity = { segmentId: input.segmentId, incarnationId: input.incarnationId };
  const rows = toSnapshotRows(input.rows, identity);
  const base: SegmentSnapshot = {
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
  const candidates: SegmentSnapshot[] = [
    base,
    {
      ...base,
      childPanes: base.childPanes.map((pane) => ({ ...pane, rows: null, droppedRanges: [] })),
      childPanesNotice: "over_cap",
    },
    { ...base, childPanes: [], childPanesNotice: "over_cap" },
  ];
  for (const candidate of candidates) {
    if (encodedSize(candidate) <= SNAPSHOT_BYTE_CAP) return candidate;
  }
  const bare = candidates[candidates.length - 1];
  const trimmed = trimOldest(rows, SNAPSHOT_BYTE_CAP, (attempt) =>
    encodedSize({ ...bare, rows: attempt.rows, droppedRanges: attempt.droppedRanges }),
  );
  const sealed: SegmentSnapshot = {
    ...bare,
    rows: trimmed.rows,
    droppedRanges: trimmed.droppedRanges,
    coverage: trimmed.droppedRanges.length > 0 ? "truncated" : "complete",
  };
  const bytes = encodedSize(sealed);
  if (bytes > SNAPSHOT_BYTE_CAP) {
    throw new SnapshotTooLargeError(input.agentId, input.incarnationId, bytes);
  }
  return sealed;
}

/**
 * Sealed retired history: `{directory}/{agentId}/{incarnationId}.json`, written once and never
 * rewritten. Sealing is serialized per incarnation in this process and published create-once
 * on disk, so two sealers of one incarnation see exactly one winner.
 */
export class SegmentSnapshotStore {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  seal(input: SealSnapshotInput): Promise<SegmentSnapshot> {
    const key = `${input.agentId}/${input.incarnationId}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        const snapshot = buildSegmentSnapshot(input);
        const created = await writeJsonFileCreateOnce(
          this.filePath(input.agentId, input.incarnationId),
          snapshot,
        );
        if (!created) {
          throw new SnapshotAlreadySealedError(input.agentId, input.incarnationId);
        }
        return snapshot;
      });
    this.tails.set(key, result);
    void result
      .finally(() => {
        if (this.tails.get(key) === result) this.tails.delete(key);
      })
      .catch(() => undefined);
    return result;
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

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
