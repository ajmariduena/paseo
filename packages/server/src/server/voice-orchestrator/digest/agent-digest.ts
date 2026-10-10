import { basename } from "node:path";
import { isPeerMessage } from "@getpaseo/protocol/peer-message";
import type { VoiceFleetAgent } from "@getpaseo/protocol/voice-fleet/types";
import type {
  AgentPermissionRequest,
  AgentTimelineItem,
  ToolCallDetail,
} from "../../agent/agent-sdk-types.js";
import { isSystemInjectedEnvelope } from "../../agent/agent-messages/index.js";
import { speakableClip } from "../speakable.js";

export interface DigestAgentInput {
  id: string;
  title: string;
  provider: string;
  workspaceId: string | null;
  workspace: string;
  projectId: string | null;
  lifecycle: "initializing" | "idle" | "running" | "error" | "closed";
  pendingPermissions: readonly AgentPermissionRequest[];
  lastError: string | null;
  finishedUnreviewed: boolean;
  activeTurnStartedAt: Date | null;
  updatedAt: Date;
  unheard: boolean;
}

const TASK_MAX = 180;
const NOW_MAX = 160;
const OUTCOME_MAX = 320;
const BLOCKER_MAX = 200;
// Interim notes older than the latest tool calls by this many items describe an earlier step.
const NOW_NOTE_MAX_TOOLS_AFTER = 6;

/**
 * The rules-only digest of one agent: everything a voice answer needs without a model call.
 * Built from the agent's live timeline, so it costs nothing to refresh on every change.
 */
export function buildAgentDigest(params: {
  agent: DigestAgentInput;
  timeline: readonly AgentTimelineItem[];
  now: number;
  summary?: string | null;
}): VoiceFleetAgent {
  const { agent, timeline, now } = params;
  const turn = latestTurn(timeline);
  const status = describeStatus(agent);
  const running = agent.lifecycle === "running" || agent.lifecycle === "initializing";
  const statusSince = running
    ? (agent.activeTurnStartedAt?.getTime() ?? agent.updatedAt.getTime())
    : agent.updatedAt.getTime();
  const todo = latestTodo(turn.items);
  const finalMessage = running ? null : lastAssistantMessage(turn.items);
  return {
    agentId: agent.id,
    title: agent.title,
    workspaceId: agent.workspaceId,
    workspace: agent.workspace,
    projectId: agent.projectId,
    provider: agent.provider,
    status,
    statusForMs: Math.max(0, now - statusSince),
    task: turn.request ? speakableClip(turn.request, TASK_MAX) : null,
    now: running ? describeNow(turn.items, todo) : null,
    progress: todo ? describeProgress(todo) : null,
    activity: describeActivity(turn.items),
    blocker: describeBlocker(agent),
    permissionId: agent.pendingPermissions.at(-1)?.id ?? null,
    outcome: finalMessage ? speakableClip(finalMessage, OUTCOME_MAX) : null,
    summary: params.summary ?? null,
    unheard: agent.unheard,
    updatedAt: new Date(agent.updatedAt.getTime()).toISOString(),
  };
}

function describeStatus(agent: DigestAgentInput): string {
  if (agent.pendingPermissions.length > 0) return "waiting_permission";
  if (agent.lifecycle === "error") return "failed";
  if (agent.lifecycle === "running") return "working";
  if (agent.lifecycle === "initializing") return "initializing";
  if (agent.finishedUnreviewed) return "finished_unreviewed";
  return "idle";
}

interface Turn {
  request: string | null;
  items: readonly AgentTimelineItem[];
}

/** The items since the user's latest real request (system and peer envelopes don't count). */
function latestTurn(timeline: readonly AgentTimelineItem[]): Turn {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (
      item.type === "user_message" &&
      !isSystemInjectedEnvelope(item.text) &&
      !isPeerMessage(item.text)
    ) {
      return { request: item.text, items: timeline.slice(index + 1) };
    }
  }
  return { request: null, items: timeline.slice(-200) };
}

type TodoItems = Extract<AgentTimelineItem, { type: "todo" }>["items"];

function latestTodo(items: readonly AgentTimelineItem[]): TodoItems | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "todo" && item.items.length > 0) return item.items;
  }
  return null;
}

function describeProgress(todo: TodoItems): string | null {
  const done = todo.filter((entry) => entry.completed || entry.status === "completed").length;
  if (todo.length < 2) return null;
  return `${done} of ${todo.length} steps done`;
}

/**
 * The freshest signal of what the agent is doing: its newest progress note when it wrote one
 * recently, else its in-progress todo, else the tool it is running.
 */
function describeNow(items: readonly AgentTimelineItem[], todo: TodoItems | null): string | null {
  let toolsAfterNote = 0;
  let note: string | null = null;
  let runningTool: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "tool_call") {
      if (!runningTool && item.status === "running") runningTool = describeToolCall(item.detail);
      toolsAfterNote += 1;
      continue;
    }
    if (item.type === "assistant_message" && item.text.trim()) {
      note = item.text;
      break;
    }
  }
  const active =
    todo?.find((entry) => entry.status === "in_progress") ??
    todo?.find((entry) => !entry.completed && entry.status !== "completed");
  const step = active ? (active.activeForm ?? active.text) : null;
  if (note && toolsAfterNote <= NOW_NOTE_MAX_TOOLS_AFTER) {
    const clipped = speakableClip(lastSentences(note, 2), NOW_MAX);
    return step ? `${speakableClip(step, 80)}; latest note: ${clipped}` : clipped;
  }
  if (step) return speakableClip(step, NOW_MAX);
  if (runningTool) return runningTool;
  return note ? speakableClip(lastSentences(note, 2), NOW_MAX) : null;
}

function lastSentences(text: string, count: number): string {
  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim().length > 0);
  return sentences.slice(-count).join(" ");
}

function describeToolCall(detail: ToolCallDetail): string | null {
  switch (detail.type) {
    case "shell":
      return `running ${speakableClip(detail.command.split("\n")[0] ?? "", 60)}`;
    case "edit":
    case "write":
      return `editing ${basename(detail.filePath)}`;
    case "read":
      return `reading ${basename(detail.filePath)}`;
    case "search":
      return detail.toolName === "web_search"
        ? `searching the web for ${speakableClip(detail.query, 50)}`
        : `searching the code`;
    case "fetch":
      return "reading a web page";
    case "sub_agent":
      return detail.description
        ? `running a subagent: ${speakableClip(detail.description, 60)}`
        : "running a subagent";
    case "worktree_setup":
      return "setting up its worktree";
    case "plan":
      return "writing a plan";
    case "plain_text":
      return detail.label ? speakableClip(detail.label, 60) : null;
    case "unknown":
      return null;
  }
}

interface ActivityCounts {
  edited: Set<string>;
  commands: string[];
  failedCommands: number;
  searches: number;
  reads: number;
  subagents: number;
}

function countActivity(items: readonly AgentTimelineItem[]): ActivityCounts {
  const counts: ActivityCounts = {
    edited: new Set(),
    commands: [],
    failedCommands: 0,
    searches: 0,
    reads: 0,
    subagents: 0,
  };
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const { detail } = item;
    if (detail.type === "edit" || detail.type === "write") {
      counts.edited.add(basename(detail.filePath));
    } else if (detail.type === "shell") {
      counts.commands.push(detail.command.split("\n")[0] ?? detail.command);
      if (item.status === "failed" || (detail.exitCode ?? 0) !== 0) counts.failedCommands += 1;
    } else if (detail.type === "search" || detail.type === "fetch") {
      counts.searches += 1;
    } else if (detail.type === "read") {
      counts.reads += 1;
    } else if (detail.type === "sub_agent") {
      counts.subagents += 1;
    }
  }
  return counts;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Counted work since the latest request: what changed and what ran, never raw output. */
function describeActivity(items: readonly AgentTimelineItem[]): string | null {
  const counts = countActivity(items);
  const parts: string[] = [];
  if (counts.edited.size > 0) {
    const names = [...counts.edited].slice(-3).join(", ");
    const more = counts.edited.size > 3 ? ", …" : "";
    parts.push(`edited ${plural(counts.edited.size, "file")} (${names}${more})`);
  }
  if (counts.commands.length > 0) {
    const last = speakableClip(counts.commands.at(-1) ?? "", 50);
    const failed = counts.failedCommands > 0 ? `, ${counts.failedCommands} failed` : "";
    parts.push(`ran ${plural(counts.commands.length, "command")}${failed} (latest: ${last})`);
  }
  if (counts.subagents > 0) parts.push(`used ${plural(counts.subagents, "subagent")}`);
  if (counts.searches + counts.reads > 0 && parts.length === 0) {
    parts.push(`read ${plural(counts.reads, "file")} and ran ${counts.searches} searches`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function describeBlocker(agent: DigestAgentInput): string | null {
  const permission = agent.pendingPermissions.at(-1);
  if (permission) return `permission: ${describePermission(permission)}`;
  if (agent.lifecycle === "error" && agent.lastError) {
    return `error: ${speakableClip(agent.lastError, BLOCKER_MAX)}`;
  }
  return null;
}

/** What the agent asks to do, from the structured detail when there is one. */
export function describePermission(permission: AgentPermissionRequest): string {
  const detail = permission.detail;
  if (detail?.type === "shell") return `run ${speakableClip(detail.command, 120)}`;
  if (detail?.type === "edit" || detail?.type === "write") {
    return `edit ${basename(detail.filePath)}`;
  }
  if (detail?.type === "fetch") return `open a web page`;
  if (detail?.type === "plan") return "approve its plan";
  const label = [permission.title ?? permission.name, permission.description]
    .filter(Boolean)
    .join(": ");
  return speakableClip(label, BLOCKER_MAX);
}

function lastAssistantMessage(items: readonly AgentTimelineItem[]): string | null {
  const chunks: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "assistant_message") {
      if (chunks.length > 0) break;
      continue;
    }
    chunks.push(item.text);
  }
  const text = chunks.toReversed().join("").trim();
  return text || null;
}

/** A compact, human line for a voice model. Times are relative to `now`. */
export function formatDigestLine(agent: VoiceFleetAgent, options?: { host?: string }): string {
  const where = [options?.host, agent.workspace].filter(Boolean).join(" · ");
  const head = `${where} · "${agent.title}" (${agent.provider})`;
  const parts: string[] = [`${describeStatusWords(agent)}`];
  if (agent.summary) parts.push(`summary: ${agent.summary}`);
  if (agent.blocker) parts.push(agent.blocker);
  if (agent.now && !agent.summary) parts.push(`now: ${agent.now}`);
  if (agent.progress) parts.push(agent.progress);
  if (agent.activity && agent.status === "working") parts.push(`so far: ${agent.activity}`);
  if (agent.task) parts.push(`task: ${agent.task}`);
  if (agent.outcome && !agent.summary) parts.push(`result: ${agent.outcome}`);
  if (agent.unheard) parts.push("NOT YET TOLD TO THE USER");
  return `${head} — ${parts.join(" | ")}`;
}

function describeStatusWords(agent: VoiceFleetAgent): string {
  const age = agent.statusForMs !== undefined ? formatAge(agent.statusForMs) : null;
  switch (agent.status) {
    case "working":
      return age ? `working for ${age}` : "working";
    case "waiting_permission":
      return age ? `waiting for permission for ${age}` : "waiting for permission";
    case "failed":
      return age ? `failed ${age} ago` : "failed";
    case "finished_unreviewed":
      return age ? `finished ${age} ago, not reviewed` : "finished, not reviewed";
    case "initializing":
      return "starting";
    default:
      return age ? `idle for ${age}` : "idle";
  }
}

export function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** The latest turn as short log lines for a model to summarize: no raw output, no code. */
export function condenseTurn(
  timeline: readonly AgentTimelineItem[],
  maxLines: number,
): { request: string | null; lines: string[]; finalMessage: string | null } {
  const turn = latestTurn(timeline);
  const lines: string[] = [];
  for (const item of turn.items) {
    switch (item.type) {
      case "assistant_message":
        if (item.text.trim()) lines.push(`said: ${speakableClip(item.text, 220)}`);
        break;
      case "tool_call": {
        const what = describeToolCall(item.detail) ?? item.name;
        const failed = item.status === "failed" ? " (failed)" : "";
        lines.push(`${what}${failed}`);
        break;
      }
      case "todo":
        lines.push(
          `plan: ${item.items
            .map(
              (entry) =>
                `${entry.completed || entry.status === "completed" ? "[x]" : "[ ]"} ${speakableClip(entry.text, 60)}`,
            )
            .join("; ")}`,
        );
        break;
      case "error":
        lines.push(`error: ${speakableClip(item.message, 160)}`);
        break;
      default:
        break;
    }
  }
  const merged: string[] = [];
  for (const line of lines) {
    if (merged.at(-1) === line) continue;
    merged.push(line);
  }
  return {
    request: turn.request,
    lines: merged.slice(-maxLines),
    finalMessage: lastAssistantMessage(turn.items),
  };
}
