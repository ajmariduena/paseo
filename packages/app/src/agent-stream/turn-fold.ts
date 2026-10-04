import type { StreamItem, ToolCallItem, UserMessageItem } from "@/types/stream";
import { describeToolCall } from "@/tool-calls/detail-level/grouping";
import { isSubagentNotification } from "@/subagents/timeline/notification-source";
import { isSubagentSpawnCall } from "@/subagents/timeline/spawn-call";
import {
  summarizeOverviewToolCalls,
  type OverviewSummary,
} from "@/tool-calls/detail-level/overview/model";
import { buildLineDiff, parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { getStreamItemMessageId } from "./message-id";

export interface TurnFileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface TurnFold {
  /** Survives reloads: the expanded state is remembered under this key. */
  key: string;
  state: "running" | "complete";
  expanded: boolean;
  startedAt: Date;
  durationMs: number;
  stepCount: number;
  summary: OverviewSummary;
  files: readonly TurnFileChange[];
  /** Messages the collapsed fold keeps off screen, for chat find. */
  hiddenMessageIds: ReadonlySet<string>;
}

export interface TurnFoldRow {
  role: "header" | "files";
  fold: TurnFold;
}

export interface TurnFoldProjection {
  tail: StreamItem[];
  rowsById: ReadonlyMap<string, TurnFoldRow>;
  folds: readonly TurnFold[];
}

/**
 * `settling` is an idle turn whose last rows still stream in the head: the tail does not
 * hold its answer yet, so it is neither folded nor shown as running.
 */
export type LatestTurnPhase = "running" | "settling" | "complete";

export interface TurnFoldInput {
  tail: StreamItem[];
  latestTurn: LatestTurnPhase;
  expandedKeys: ReadonlySet<string>;
  /** The calls behind a row: a grouped host stands for its whole run. */
  getToolCalls: (item: ToolCallItem) => readonly ToolCallItem[];
}

export const TURN_FOLD_TOOL_NAME = "paseo_turn_fold";

const SYSTEM_ERROR_MESSAGE = /^\s*\[System Error\]/;
const QUESTION_TOOL_NAME = /^(?:ask_?user_?question|request_user_input(?:_async)?|question)$/;
const MAX_LINE_DIFF_CELLS = 40_000;
const EMPTY_ROWS = new Map<string, TurnFoldRow>();
const EMPTY_FOLDS: readonly TurnFold[] = [];
const EMPTY_MESSAGE_IDS: ReadonlySet<string> = new Set();
const EMPTY_SUMMARY: OverviewSummary = {
  editedFileCount: 0,
  commandCount: 0,
  readFileCount: 0,
  searchCount: 0,
  otherToolCount: 0,
  paseoActivities: [],
  paseoCallCount: 0,
};

export function getTurnFoldKey(user: UserMessageItem): string {
  const cursor = user.timelineCursor;
  return cursor ? `${cursor.epoch}:${cursor.seq}` : user.id;
}

export function findCollapsedTurnFoldKey(
  projection: Pick<TurnFoldProjection, "folds">,
  messageId: string,
): string | null {
  for (const fold of projection.folds) {
    if (!fold.expanded && fold.hiddenMessageIds.has(messageId)) {
      return fold.key;
    }
  }
  return null;
}

function countLines(text: string | undefined): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

function countEditLines(detail: { oldString?: string; newString?: string; unifiedDiff?: string }): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  if (detail.unifiedDiff) {
    for (const line of parseUnifiedDiff(detail.unifiedDiff)) {
      if (line.type === "add") additions += 1;
      else if (line.type === "remove") deletions += 1;
    }
    return { additions, deletions };
  }
  const oldLines = countLines(detail.oldString);
  const newLines = countLines(detail.newString);
  // The line diff is quadratic; past this size the raw line counts are close enough.
  if (oldLines * newLines > MAX_LINE_DIFF_CELLS) {
    return { additions: newLines, deletions: oldLines };
  }
  for (const line of buildLineDiff(detail.oldString ?? "", detail.newString ?? "")) {
    if (line.type === "add") additions += 1;
    else if (line.type === "remove") deletions += 1;
  }
  return { additions, deletions };
}

// Every fold is rebuilt on each tail change; source calls keep their identity, so the line
// diff of an edit is paid once.
const fileChangeByCall = new WeakMap<ToolCallItem, TurnFileChange | null>();

function getCallFileChange(call: ToolCallItem): TurnFileChange | null {
  const cached = fileChangeByCall.get(call);
  if (cached !== undefined) return cached;
  const { detail, status } = describeToolCall(call);
  let change: TurnFileChange | null = null;
  if (status !== "failed" && status !== "canceled") {
    if (detail.type === "edit") {
      change = { path: detail.filePath, ...countEditLines(detail) };
    } else if (detail.type === "write") {
      change = { path: detail.filePath, additions: countLines(detail.content), deletions: 0 };
    }
  }
  fileChangeByCall.set(call, change);
  return change;
}

export function collectTurnFileChanges(calls: readonly ToolCallItem[]): TurnFileChange[] {
  const byPath = new Map<string, TurnFileChange>();
  for (const call of calls) {
    const change = getCallFileChange(call);
    if (!change) continue;
    const existing = byPath.get(change.path);
    byPath.set(change.path, {
      path: change.path,
      additions: (existing?.additions ?? 0) + change.additions,
      deletions: (existing?.deletions ?? 0) + change.deletions,
    });
  }
  return [...byPath.values()];
}

// Subagent rows stay visible in a collapsed turn: they are the way to the children it started.
function isPinnedCall(call: ToolCallItem): boolean {
  const descriptor = describeToolCall(call);
  return (
    descriptor.detail.type === "plan" ||
    QUESTION_TOOL_NAME.test(descriptor.name.trim().toLowerCase()) ||
    isSubagentSpawnCall(call)
  );
}

function isPinnedRow(row: StreamItem, getToolCalls: TurnFoldInput["getToolCalls"]): boolean {
  // An agent can answer and then run a tool, so any message may hold the answer.
  if (row.kind === "assistant_message") return true;
  if (row.kind === "notification") return row.level !== "info" || isSubagentNotification(row);
  if (row.kind !== "tool_call") return false;
  return getToolCalls(row).some(isPinnedCall);
}

function endsTurnInFailure(row: StreamItem, calls: readonly ToolCallItem[]): boolean {
  if (row.kind === "notification") return row.level === "error";
  if (row.kind === "assistant_message") return SYSTEM_ERROR_MESSAGE.test(row.text);
  return calls.some((call) => describeToolCall(call).status === "canceled");
}

function areFileChangesEqual(
  left: readonly TurnFileChange[],
  right: readonly TurnFileChange[],
): boolean {
  return (
    left.length === right.length &&
    left.every((change, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        change.path === other.path &&
        change.additions === other.additions &&
        change.deletions === other.deletions
      );
    })
  );
}

function arePaseoActivitiesEqual(
  left: OverviewSummary["paseoActivities"],
  right: OverviewSummary["paseoActivities"],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.activity === other.activity &&
        entry.count === other.count &&
        entry.agentCount === other.agentCount &&
        entry.failedOnly === other.failedOnly
      );
    })
  );
}

function areSummariesEqual(left: OverviewSummary, right: OverviewSummary): boolean {
  return (
    left.editedFileCount === right.editedFileCount &&
    left.commandCount === right.commandCount &&
    left.readFileCount === right.readFileCount &&
    left.searchCount === right.searchCount &&
    left.otherToolCount === right.otherToolCount &&
    arePaseoActivitiesEqual(left.paseoActivities, right.paseoActivities) &&
    left.paseoCallCount === right.paseoCallCount
  );
}

function areTurnFoldsEquivalent(left: TurnFold, right: TurnFold): boolean {
  return (
    left.key === right.key &&
    left.state === right.state &&
    left.expanded === right.expanded &&
    left.startedAt.getTime() === right.startedAt.getTime() &&
    left.durationMs === right.durationMs &&
    left.stepCount === right.stepCount &&
    areSummariesEqual(left.summary, right.summary) &&
    areFileChangesEqual(left.files, right.files)
  );
}

interface RowAnchor {
  id: string;
  turnId: string | undefined;
  timestamp: Date;
  timelineCursor: StreamItem["timelineCursor"];
}

function createFoldRowItem(anchor: RowAnchor): ToolCallItem {
  return {
    kind: "tool_call",
    id: anchor.id,
    ...(anchor.turnId !== undefined ? { turnId: anchor.turnId } : {}),
    ...(anchor.timelineCursor ? { timelineCursor: anchor.timelineCursor } : {}),
    timestamp: anchor.timestamp,
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: anchor.id,
        toolName: TURN_FOLD_TOOL_NAME,
        arguments: null,
        status: "completed",
      },
    },
  };
}

function isSameAnchor(item: ToolCallItem, anchor: RowAnchor): boolean {
  return (
    item.turnId === anchor.turnId &&
    item.timestamp.getTime() === anchor.timestamp.getTime() &&
    item.timelineCursor?.epoch === anchor.timelineCursor?.epoch &&
    item.timelineCursor?.seq === anchor.timelineCursor?.seq
  );
}

/** The block rows of the last assistant message, when the response ends with it. */
function findFinalAnswer(rows: readonly StreamItem[]): { start: number; end: number } | null {
  const end = rows.findLastIndex((row) => row.kind === "assistant_message");
  const answerRow = rows[end];
  if (!answerRow) return null;
  if (rows.slice(end + 1).some((row) => row.kind === "tool_call" || row.kind === "thought")) {
    return null;
  }
  const answerId = getStreamItemMessageId(answerRow);
  let start = end;
  while (start > 0) {
    const previous = rows[start - 1]!;
    if (previous.kind !== "assistant_message" || getStreamItemMessageId(previous) !== answerId) {
      break;
    }
    start -= 1;
  }
  return { start, end };
}

function collectSucceededTurnCalls(
  rows: readonly StreamItem[],
  getToolCalls: TurnFoldInput["getToolCalls"],
): ToolCallItem[] | null {
  const calls: ToolCallItem[] = [];
  for (const row of rows) {
    const rowCalls = row.kind === "tool_call" ? getToolCalls(row) : [];
    if (endsTurnInFailure(row, rowCalls)) return null;
    calls.push(...rowCalls);
  }
  return calls;
}

interface EmittedRow {
  fold: TurnFold;
  item: ToolCallItem;
}

interface SegmentPlan {
  rows: StreamItem[];
}

/**
 * Synthetic rows keep their identity while what they show is unchanged. Grouped hosts are
 * rebuilt on every tail change, so the identity of the rows a fold covers cannot tell that.
 */
export function createTurnFolding() {
  let previousRows = new Map<string, EmittedRow>();

  return function foldTurns(input: TurnFoldInput): TurnFoldProjection {
    const nextRows = new Map<string, EmittedRow>();
    const rowsById = new Map<string, TurnFoldRow>();
    const folds: TurnFold[] = [];

    const emit = (role: TurnFoldRow["role"], fold: TurnFold, anchor: RowAnchor): ToolCallItem => {
      const previous = previousRows.get(anchor.id);
      const item =
        previous &&
        areTurnFoldsEquivalent(previous.fold, fold) &&
        isSameAnchor(previous.item, anchor)
          ? previous.item
          : createFoldRowItem(anchor);
      nextRows.set(anchor.id, { fold, item });
      rowsById.set(anchor.id, { role, fold });
      return item;
    };

    const planRunning = (user: UserMessageItem, rows: StreamItem[]): SegmentPlan => {
      const fold: TurnFold = {
        key: getTurnFoldKey(user),
        state: "running",
        expanded: true,
        startedAt: user.timestamp,
        durationMs: 0,
        stepCount: 0,
        summary: EMPTY_SUMMARY,
        files: [],
        hiddenMessageIds: EMPTY_MESSAGE_IDS,
      };
      folds.push(fold);
      const header = emit("header", fold, {
        id: `${user.id}:turn-fold`,
        turnId: rows[0]?.turnId ?? user.turnId,
        timestamp: user.timestamp,
        timelineCursor: user.timelineCursor,
      });
      return { rows: [header, ...rows] };
    };

    const planComplete = (user: UserMessageItem, rows: StreamItem[]): SegmentPlan | null => {
      const answer = findFinalAnswer(rows);
      const calls = answer ? collectSucceededTurnCalls(rows, input.getToolCalls) : null;
      if (!answer || !calls) return null;
      const { start: answerStart, end: answerEnd } = answer;
      const work = rows.slice(0, answerStart);
      const pinned: StreamItem[] = [];
      const hidden: StreamItem[] = [];
      for (const row of work) {
        (isPinnedRow(row, input.getToolCalls) ? pinned : hidden).push(row);
      }
      if (hidden.length === 0) return null;

      const key = getTurnFoldKey(user);
      const expanded = input.expandedKeys.has(key);
      const lastRow = rows[rows.length - 1]!;
      const fold: TurnFold = {
        key,
        state: "complete",
        expanded,
        startedAt: user.timestamp,
        durationMs: Math.max(0, lastRow.timestamp.getTime() - user.timestamp.getTime()),
        stepCount: calls.length,
        summary: summarizeOverviewToolCalls(calls).summary,
        files: collectTurnFileChanges(calls),
        hiddenMessageIds: expanded
          ? EMPTY_MESSAGE_IDS
          : new Set(hidden.map(getStreamItemMessageId)),
      };
      folds.push(fold);

      const header = emit("header", fold, {
        id: `${user.id}:turn-fold`,
        turnId: rows[0]?.turnId ?? user.turnId,
        timestamp: user.timestamp,
        timelineCursor: user.timelineCursor,
      });
      const lastAnswerBlock = rows[answerEnd]!;
      const filesRow =
        fold.files.length > 0
          ? emit("files", fold, {
              id: `${user.id}:turn-files`,
              turnId: lastAnswerBlock.turnId,
              timestamp: lastAnswerBlock.timestamp,
              timelineCursor: lastAnswerBlock.timelineCursor,
            })
          : null;

      return {
        rows: [
          header,
          ...(expanded ? work : pinned),
          ...rows.slice(answerStart, answerEnd + 1),
          ...(filesRow ? [filesRow] : []),
          ...rows.slice(answerEnd + 1),
        ],
      };
    };

    const userIndices: number[] = [];
    for (const [index, item] of input.tail.entries()) {
      if (item.kind === "user_message") userIndices.push(index);
    }

    let output: StreamItem[] | null = null;
    let copiedUntil = 0;
    for (const [position, userIndex] of userIndices.entries()) {
      const user = input.tail[userIndex] as UserMessageItem;
      const isLatest = position === userIndices.length - 1;
      const end = isLatest ? input.tail.length : userIndices[position + 1]!;
      const rows = input.tail.slice(userIndex + 1, end);
      let plan: SegmentPlan | null = null;
      if (!isLatest || input.latestTurn === "complete") {
        plan = planComplete(user, rows);
      } else if (input.latestTurn === "running") {
        plan = planRunning(user, rows);
      }
      if (!plan) continue;
      output ??= [];
      for (let index = copiedUntil; index <= userIndex; index += 1) {
        output.push(input.tail[index]!);
      }
      for (const row of plan.rows) output.push(row);
      copiedUntil = end;
    }

    previousRows = nextRows;
    if (!output) {
      return { tail: input.tail, rowsById: EMPTY_ROWS, folds: EMPTY_FOLDS };
    }
    for (let index = copiedUntil; index < input.tail.length; index += 1) {
      output.push(input.tail[index]!);
    }
    return { tail: output, rowsById, folds };
  };
}
