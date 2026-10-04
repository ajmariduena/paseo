import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { SubagentRow } from "@/subagents/select";
import {
  resolvePaseoSubagentStatus,
  resolveProviderSubagentStatus,
  type SubagentStatus,
} from "@/subagents/presentation/status";
import type { SubagentOpenTarget } from "@/subagents/timeline/model";
import { resolveRowLabel, resolveSubagentRowTiming } from "@/subagents/track-presentation";

export const LINEAGE_PAGE_SIZE = 6;
export const LINEAGE_PAGE_STEP = 12;

export interface LineageRow {
  key: string;
  title: string | null;
  provider: string;
  status: SubagentStatus;
  liveSince: Date | null;
  settledDurationMs: number | null;
  createdAt: Date;
  target: SubagentOpenTarget;
}

export interface LineageParent {
  id: string;
  title: string | null;
  provider: string;
  status: SubagentStatus;
  modelLabel: string | null;
}

/** An archived child as `fetch_agents` returns it. */
export type ArchivedLineageAgent = Pick<
  AgentSnapshotPayload,
  "id" | "provider" | "title" | "createdAt" | "archivedAt"
>;

export interface LineageSections {
  parent: LineageParent | null;
  /** Children still worth a look: working, waiting on input, or finished and unread. */
  subagents: LineageRow[];
  /** Children already read or failed, and archived ones once asked for. */
  previous: LineageRow[];
  previousFailedCount: number;
  runningCount: number;
}

function toChildRow(row: SubagentRow): LineageRow {
  const timing = resolveSubagentRowTiming(row);
  const status =
    row.kind === "paseo"
      ? resolvePaseoSubagentStatus({
          status: row.status,
          turn: row.turn,
          pendingPermissionCount: 0,
          requiresAttention: row.requiresAttention === true,
          attentionReason: null,
          isArchived: false,
        })
      : resolveProviderSubagentStatus(row.status);
  const target: SubagentOpenTarget =
    row.kind === "paseo"
      ? { kind: "agent", agentId: row.id }
      : { kind: "provider_subagent", parentAgentId: row.parentAgentId, subagentId: row.id };
  return {
    key: `${row.kind}:${row.id}`,
    title: resolveRowLabel(row.description) ?? resolveRowLabel(row.title),
    provider: row.provider,
    status,
    liveSince: timing.liveSince,
    settledDurationMs: timing.settledDurationMs,
    createdAt: row.createdAt,
    target,
  };
}

function toArchivedRow(agent: ArchivedLineageAgent): LineageRow {
  return {
    key: `paseo:${agent.id}`,
    title: resolveRowLabel(agent.title),
    provider: agent.provider,
    status: resolvePaseoSubagentStatus(null),
    liveSince: null,
    settledDurationMs: null,
    createdAt: new Date(agent.createdAt),
    target: { kind: "agent", agentId: agent.id },
  };
}

function isCurrent(row: LineageRow): boolean {
  return row.status.isLive || row.status.bucket === "attention";
}

// Newest first, and by creation alone, so a child finishing or waking never moves its row.
function byCreatedAtDescending(left: LineageRow, right: LineageRow): number {
  return right.createdAt.getTime() - left.createdAt.getTime();
}

/**
 * An agent session's relationships, sectioned the way the Lineage surface lists them. A child's
 * live turn wins over its settled snapshot, so a parent's follow-up shows it working again.
 */
export function buildLineageSections(input: {
  parent: LineageParent | null;
  children: readonly SubagentRow[];
  archived: readonly ArchivedLineageAgent[] | null;
}): LineageSections {
  const childRows = input.children.map(toChildRow);
  const knownKeys = new Set(childRows.map((row) => row.key));
  const archivedRows = (input.archived ?? [])
    .filter((agent) => agent.archivedAt)
    .map(toArchivedRow)
    .filter((row) => !knownKeys.has(row.key));
  const subagents = childRows.filter(isCurrent).sort(byCreatedAtDescending);
  const previous = [...childRows.filter((row) => !isCurrent(row)), ...archivedRows].sort(
    byCreatedAtDescending,
  );
  return {
    parent: input.parent,
    subagents,
    previous,
    previousFailedCount: previous.filter((row) => row.status.word === "failed").length,
    runningCount: childRows.filter((row) => row.status.isLive).length,
  };
}

export interface LineagePage {
  visible: LineageRow[];
  /** Rows the next "Show N more" reveals. */
  nextCount: number;
}

export function pageLineageRows(rows: readonly LineageRow[], limit: number): LineagePage {
  return {
    visible: rows.slice(0, limit),
    nextCount: Math.min(LINEAGE_PAGE_STEP, Math.max(0, rows.length - limit)),
  };
}
