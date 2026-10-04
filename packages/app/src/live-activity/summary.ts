import type { AgentDirectoryEntry } from "@/types/agent-directory";

export type LiveActivityLineState = "permission" | "working" | "error" | "finished";

/** Field names are the ContentState JSON keys in modules/paseo-live-activity. */
export interface LiveActivityLine {
  id: string;
  title: string;
  state: LiveActivityLineState;
  label: string;
  since: number;
}

export interface LiveActivityContent {
  headline: string;
  working: number;
  waiting: number;
  workingLabel: string;
  waitingLabel: string;
  lines: LiveActivityLine[];
}

export interface LiveActivityLabels {
  headline(counts: { working: number; waiting: number; finished: number }): string;
  working(count: number): string;
  waiting(count: number): string;
  permission: string;
  finished: string;
  failed: string;
  untitled: string;
}

const MAX_LINES = 3;
const ORDER: Record<LiveActivityLineState, number> = {
  permission: 0,
  working: 1,
  error: 2,
  finished: 3,
};

function lineStateOf(agent: AgentDirectoryEntry, since: number): LiveActivityLineState | null {
  if (agent.archivedAt) return null;
  if ((agent.pendingPermissionCount ?? 0) > 0) return "permission";
  if (agent.status === "running") return "working";
  const settledAt = agent.attentionTimestamp?.getTime() ?? 0;
  if (!agent.requiresAttention || settledAt < since) return null;
  if (agent.attentionReason === "error") return "error";
  if (agent.attentionReason === "finished") return "finished";
  return null;
}

/**
 * What the Live Activity shows: agents asking for permission first, then working ones, then
 * results that landed since the activity started. Null once nothing is left to show.
 */
export function summarizeAgents(input: {
  agents: readonly AgentDirectoryEntry[];
  since: number;
  runningSince: ReadonlyMap<string, number>;
  labels: LiveActivityLabels;
}): LiveActivityContent | null {
  const { labels } = input;
  const entries: Array<{ agent: AgentDirectoryEntry; state: LiveActivityLineState }> = [];
  for (const agent of input.agents) {
    const state = lineStateOf(agent, input.since);
    if (state) entries.push({ agent, state });
  }
  if (entries.length === 0) return null;
  const count = (state: LiveActivityLineState) =>
    entries.filter((entry) => entry.state === state).length;
  const working = count("working");
  const waiting = count("permission");
  const finished = count("finished") + count("error");

  entries.sort(
    (left, right) =>
      ORDER[left.state] - ORDER[right.state] ||
      right.agent.lastActivityAt.getTime() - left.agent.lastActivityAt.getTime(),
  );
  const lines = entries.slice(0, MAX_LINES).map(({ agent, state }) => {
    const key = `${agent.serverId}:${agent.id}`;
    let label = labels.finished;
    if (state === "permission") label = labels.permission;
    else if (state === "error") label = labels.failed;
    else if (state === "working") label = "";
    return {
      id: key,
      title: agent.title?.trim() || labels.untitled,
      state,
      label,
      since: state === "working" ? Math.floor((input.runningSince.get(key) ?? 0) / 1000) : 0,
    };
  });

  return {
    headline: labels.headline({ working, waiting, finished }),
    working,
    waiting,
    workingLabel: labels.working(working),
    waitingLabel: labels.waiting(waiting),
    lines,
  };
}

export function hasActiveWork(content: LiveActivityContent): boolean {
  return content.working > 0 || content.waiting > 0;
}
