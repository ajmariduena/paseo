import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { isSubagentSpawnCall } from "@/subagents/timeline/spawn-call";

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

/** Spawn calls run separately: the timeline draws them as subagent rows, not as tool work. */
export type ToolCallRunKind = "tools" | "subagents";

export interface ToolCallRun {
  id: string;
  kind: ToolCallRunKind;
  calls: readonly ToolCallItem[];
  latest: ToolCallItem;
  isSealed: boolean;
}

export interface GroupedHistory<TGroup> {
  tail: StreamItem[];
  groupsByHostId: Map<string, TGroup>;
  pendingCalls: readonly ToolCallItem[];
  pendingKind: ToolCallRunKind | null;
}

export interface GroupedToolCalls<TGroup> {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: ToolCallGroupLookup<TGroup>;
  historyGroupUpdatesByHostId: ToolCallGroupLookup<TGroup>;
}

export interface ToolCallGroupLookup<TGroup> {
  readonly size: number;
  get(id: string): TGroup | undefined;
  has(id: string): boolean;
}

const EMPTY_GROUPS = new Map<string, never>();

export function describeToolCall(item: ToolCallItem): ToolCallDescriptor {
  if (item.payload.source === "agent") {
    const { data } = item.payload;
    return {
      detail: data.detail,
      name: data.name,
      status: data.status,
      error: data.error,
      metadata: data.metadata,
    };
  }

  const { data } = item.payload;
  return {
    detail: {
      type: "unknown",
      input: data.arguments ?? null,
      output: data.result ?? null,
    },
    name: data.toolName,
    status: data.status,
    error: data.error,
  };
}

/** The run a tool call joins, or null when it renders on its own. */
export function resolveToolCallRunKind(item: StreamItem): ToolCallRunKind | null {
  if (item.kind !== "tool_call") {
    return null;
  }
  const descriptor = describeToolCall(item);
  if (descriptor.detail.type === "plan" || descriptor.name.trim().toLowerCase() === "speak") {
    return null;
  }
  return isSubagentSpawnCall(item) ? "subagents" : "tools";
}

function createRun(
  calls: readonly ToolCallItem[],
  kind: ToolCallRunKind,
  isSealed: boolean,
): ToolCallRun {
  const first = calls[0];
  const latest = calls.at(-1);
  if (!first || !latest) {
    throw new Error("Cannot group an empty tool call run");
  }
  return { id: first.id, kind, calls, latest, isSealed };
}

function createHost(run: ToolCallRun): ToolCallItem {
  if (run.calls.length === 1) {
    return run.latest;
  }
  return { ...run.latest, id: run.id };
}

function isRunning(call: ToolCallItem): boolean {
  const status = describeToolCall(call).status;
  return status === "running" || status === "executing";
}

function appendRun<TGroup>(input: {
  calls: readonly ToolCallItem[];
  kind: ToolCallRunKind | null;
  isSealed: boolean;
  output: StreamItem[];
  groups: Map<string, TGroup>;
  buildGroup: (run: ToolCallRun) => TGroup;
}): void {
  if (input.calls.length === 0 || !input.kind) {
    return;
  }
  const run = createRun(input.calls, input.kind, input.isSealed);
  const host = createHost(run);
  input.output.push(host);
  input.groups.set(host.id, input.buildGroup(run));
}

export function prepareGroupedHistory<TGroup>(input: {
  tail: StreamItem[];
  buildGroup: (run: ToolCallRun) => TGroup;
}): GroupedHistory<TGroup> {
  const output: StreamItem[] = [];
  const groups = new Map<string, TGroup>();
  let pending: ToolCallItem[] = [];
  let pendingKind: ToolCallRunKind | null = null;
  const flush = () => {
    appendRun({
      calls: pending,
      kind: pendingKind,
      isSealed: true,
      output,
      groups,
      buildGroup: input.buildGroup,
    });
    pending = [];
    pendingKind = null;
  };

  for (const item of input.tail) {
    const kind = resolveToolCallRunKind(item);
    if (kind && item.kind === "tool_call") {
      if (pendingKind !== null && pendingKind !== kind) {
        flush();
      }
      pending.push(item);
      pendingKind = kind;
      continue;
    }
    flush();
    output.push(item);
  }

  const pendingCalls = pending;
  const trailingKind = pendingKind;
  flush();

  return {
    tail: groups.size > 0 ? output : input.tail,
    groupsByHostId: groups,
    pendingCalls,
    pendingKind: trailingKind,
  };
}

export function groupLiveToolCalls<TGroup>(input: {
  history: GroupedHistory<TGroup>;
  head: StreamItem[];
  isTurnActive: boolean;
  buildGroup: (run: ToolCallRun) => TGroup;
}): GroupedToolCalls<TGroup> {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, TGroup>();
  let pending = [...input.history.pendingCalls];
  let pendingKind = input.history.pendingKind;
  let hostPlacement: "history" | "head" | null = pending.length > 0 ? "history" : null;
  let pendingIncludesHead = false;

  const flush = (isSealed: boolean) => {
    if (pending.length === 0 || !pendingKind) {
      return;
    }
    const run = createRun(pending, pendingKind, isSealed);
    if (hostPlacement === "head") {
      head.push(createHost(run));
    }
    if (hostPlacement === "head" || pendingIncludesHead || !isSealed) {
      liveGroups.set(run.id, input.buildGroup(run));
    }
    pending = [];
    pendingKind = null;
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    const kind = resolveToolCallRunKind(item);
    if (kind && item.kind === "tool_call") {
      if (pendingKind !== null && pendingKind !== kind) {
        flush(true);
      }
      if (pending.length === 0) {
        hostPlacement = "head";
      }
      pending.push(item);
      pendingKind = kind;
      pendingIncludesHead = true;
      continue;
    }
    flush(true);
    head.push(item);
  }
  // Tool calls live in retained tail rather than the streaming head. The agent
  // lifecycle snapshot can still be idle while a newly received tool call is
  // already running, so its direct timeline status is the authoritative start
  // signal. The lifecycle state continues to keep completed calls live between
  // sequential tool updates.
  const trailingRunIsActive = input.isTurnActive || pending.some(isRunning);
  flush(!trailingRunIsActive);

  if (liveGroups.size === 0) {
    return {
      tail: input.history.tail,
      head: input.head,
      groupsByHostId: input.history.groupsByHostId,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  if (input.history.groupsByHostId.size === 0) {
    return {
      tail: input.history.tail,
      head,
      groupsByHostId: liveGroups,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  const groupsByHostId = new Map(input.history.groupsByHostId);
  let historyGroupUpdatesByHostId: Map<string, TGroup> | null = null;
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    if (input.history.groupsByHostId.has(id)) {
      historyGroupUpdatesByHostId ??= new Map();
      historyGroupUpdatesByHostId.set(id, group);
    }
  }
  return {
    tail: input.history.tail,
    head,
    groupsByHostId,
    historyGroupUpdatesByHostId: historyGroupUpdatesByHostId ?? EMPTY_GROUPS,
  };
}
