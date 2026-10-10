import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { ProviderIncarnation, ProviderSegment, ProviderSwitchRecordState } from "./record.js";
import { activeIncarnation } from "./record.js";
import type { SegmentSnapshot } from "./snapshot-store.js";

export const SEED_BYTE_CAP = 32 * 1024 * 1024;

export interface SeedCoverageGap {
  segmentId: string;
  incarnationId: string;
  reason: "dropped" | "unavailable" | "over_cap";
  /** Row indices lost at seal time; null when the whole snapshot is missing or unseeded. */
  rows: { fromRowIndex: number; toRowIndex: number } | null;
}

export interface SeededHistory {
  rows: AgentTimelineRow[];
  gaps: SeedCoverageGap[];
  /** Serialized size of the seeded snapshot rows, for the registration log. */
  bytes: number;
}

export interface SeedRetiredHistoryInput {
  state: ProviderSwitchRecordState;
  snapshots: ReadonlyMap<string, SegmentSnapshot | null>;
  now: string;
}

interface RetiredIncarnation {
  segment: ProviderSegment;
  incarnation: ProviderIncarnation;
}

function retiredIncarnations(state: ProviderSwitchRecordState): RetiredIncarnation[] {
  const active = activeIncarnation(state);
  const retired: RetiredIncarnation[] = [];
  for (const segment of state.providerSegments ?? []) {
    for (const incarnation of segment.incarnations) {
      if (incarnation.id === active?.id) continue;
      retired.push({ segment, incarnation });
    }
  }
  return retired;
}

/** Which snapshot ids the seeder will need, so the caller reads only those files. */
export function retiredSnapshotIds(state: ProviderSwitchRecordState): string[] {
  return retiredIncarnations(state).flatMap(({ incarnation }) => incarnation.snapshotId ?? []);
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function notification(
  message: string,
  level: "info" | "warning",
  providerSegment: NonNullable<
    Extract<AgentTimelineItem, { type: "notification" }>["providerSegment"]
  >,
): AgentTimelineItem {
  return { type: "notification", level, message, providerSegment };
}

function dividerRow(from: ProviderSegment, to: ProviderSegment): AgentTimelineItem {
  return notification(`Switched from ${from.provider} to ${to.provider}`, "info", {
    kind: "provider_switch",
    segmentId: to.id,
    fromProvider: from.provider,
    toProvider: to.provider,
    fromModel: from.model,
    toModel: to.model,
    handoffId: to.handoffId,
  });
}

function incarnationMarker(
  segment: ProviderSegment,
  incarnation: ProviderIncarnation & { reason: "resume_failed" | "uncertain_delivery" },
) {
  const message =
    incarnation.reason === "resume_failed"
      ? `The ${segment.provider} session could not be resumed; a new one was started`
      : `A ${segment.provider} prompt's delivery was uncertain; a new session was started`;
  return notification(message, "warning", {
    kind: "incarnation",
    segmentId: segment.id,
    incarnationId: incarnation.id,
    reason: incarnation.reason,
  });
}

function gapRow(gap: SeedCoverageGap, provider: string): AgentTimelineItem {
  const messages = {
    dropped: `Part of the earlier ${provider} history was too large to keep`,
    unavailable: `The earlier ${provider} history could not be read`,
    over_cap: `The oldest ${provider} history is not shown; the chat exceeds the retained size`,
  } as const;
  return notification(messages[gap.reason], "warning", {
    kind: "retired_history",
    segmentId: gap.segmentId,
    incarnationId: gap.incarnationId,
    reason: gap.reason,
  });
}

/**
 * Rebuilds the retired part of a switched agent's timeline from its sealed snapshots: dense
 * rows from 1, one divider per segment boundary, markers for replaced incarnations, and one
 * warning row per coverage gap. The 32 MiB cap drops the oldest snapshots in memory only.
 */
export function seedRetiredHistory(input: SeedRetiredHistoryInput): SeededHistory {
  const retired = retiredIncarnations(input.state);
  const seedable = withinSeedCap(retired, input.snapshots);
  const output = new SeedOutput();

  let previousSegment: ProviderSegment | null = null;
  for (const [index, entry] of retired.entries()) {
    if (previousSegment && previousSegment.id !== entry.segment.id) {
      output.push(dividerRow(previousSegment, entry.segment), entry.segment.startedAt);
    }
    previousSegment = entry.segment;
    seedIncarnation(entry, seedable.has(index), input.snapshots, output);
  }

  const active = input.state.providerSegments?.find((segment) => segment.endedAt === null);
  if (previousSegment && active && previousSegment.id !== active.id) {
    output.push(dividerRow(previousSegment, active), active.startedAt);
  }
  const activeInc = activeIncarnation(input.state);
  if (activeInc && active && activeInc.reason !== "switch") {
    output.push(
      incarnationMarker(active, { ...activeInc, reason: activeInc.reason }),
      activeInc.startedAt,
    );
  }
  return { rows: output.rows, gaps: output.gaps, bytes: output.bytes };
}

class SeedOutput {
  readonly rows: AgentTimelineRow[] = [];
  readonly gaps: SeedCoverageGap[] = [];
  bytes = 0;

  push(item: AgentTimelineItem, timestamp: string): void {
    this.rows.push({ seq: this.rows.length + 1, timestamp, item });
  }

  gap(gap: SeedCoverageGap, provider: string, timestamp: string): void {
    this.gaps.push(gap);
    this.push(gapRow(gap, provider), timestamp);
  }
}

/** Newest first, so the oldest retired snapshots are the ones that fall outside the cap. */
function withinSeedCap(
  retired: readonly RetiredIncarnation[],
  snapshots: ReadonlyMap<string, SegmentSnapshot | null>,
): Set<number> {
  let budget = SEED_BYTE_CAP;
  const seedable = new Set<number>();
  for (let index = retired.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshotOf(retired[index].incarnation, snapshots);
    const size = snapshot ? byteSize(snapshot.rows) : 0;
    if (size > budget) break;
    budget -= size;
    seedable.add(index);
  }
  return seedable;
}

function snapshotOf(
  incarnation: ProviderIncarnation,
  snapshots: ReadonlyMap<string, SegmentSnapshot | null>,
): SegmentSnapshot | null {
  return incarnation.snapshotId ? (snapshots.get(incarnation.snapshotId) ?? null) : null;
}

function seedIncarnation(
  { segment, incarnation }: RetiredIncarnation,
  seedable: boolean,
  snapshots: ReadonlyMap<string, SegmentSnapshot | null>,
  output: SeedOutput,
): void {
  if (incarnation.reason !== "switch") {
    output.push(
      incarnationMarker(segment, { ...incarnation, reason: incarnation.reason }),
      incarnation.startedAt,
    );
  }
  const base = { segmentId: segment.id, incarnationId: incarnation.id };
  const snapshot = snapshotOf(incarnation, snapshots);
  if (!snapshot) {
    output.gap(
      { ...base, reason: "unavailable", rows: null },
      segment.provider,
      incarnation.startedAt,
    );
    return;
  }
  if (!seedable) {
    output.gap(
      { ...base, reason: "over_cap", rows: null },
      segment.provider,
      incarnation.startedAt,
    );
    return;
  }
  for (const range of snapshot.droppedRanges) {
    output.gap(
      { ...base, reason: "dropped", rows: range },
      segment.provider,
      incarnation.startedAt,
    );
  }
  output.bytes += byteSize(snapshot.rows);
  for (const row of snapshot.rows) {
    output.rows.push({
      seq: output.rows.length + 1,
      timestamp: row.timestamp,
      item: row.item,
      origin: row.identity,
      ...(row.turnId ? { turnId: row.turnId } : {}),
    });
  }
}
