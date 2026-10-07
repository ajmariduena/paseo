import { getPaseoCallLeafName, isPaseoToolName } from "@getpaseo/protocol/tool-name-normalization";
import { isSubagentSpawnCall } from "@/subagents/timeline/spawn-call";
import type { ToolCallItem } from "@/types/stream";
import { describeToolCall, type ToolCallRun } from "../grouping";

const DIRECT_PASEO_TOOL_PREFIX = "paseo_";
const UNNAMED_AGENT_PREFIX = "call:";
const DIRECT_SEARCH_TOOL_SUFFIX_PATTERN = /(?:^|[_.:/])(?:web_search|llm_context)$/;

/** Orchestration work an overview names in its own words instead of "called Paseo N times". */
export type PaseoActivity =
  | "sentPrompts"
  | "sentNotes"
  | "waitedForAgents"
  | "checkedAgents"
  | "listedAgents"
  | "stoppedAgents"
  | "archivedAgents"
  | "answeredPermissions"
  | "createdSchedules"
  | "createdHeartbeats"
  | "checkedCapabilities"
  | "previewedHtml"
  | "renderedHtml";

const PASEO_ACTIVITY_BY_LEAF: Readonly<Record<string, PaseoActivity>> = {
  send_agent_prompt: "sentPrompts",
  wait_for_agent: "waitedForAgents",
  get_agent_status: "checkedAgents",
  get_agent_activity: "checkedAgents",
  list_agents: "listedAgents",
  cancel_agent: "stoppedAgents",
  archive_agent: "archivedAgents",
  respond_to_permission: "answeredPermissions",
  create_schedule: "createdSchedules",
  create_heartbeat: "createdHeartbeats",
  get_orchestration_capabilities: "checkedCapabilities",
  html_preview: "previewedHtml",
  html_render: "renderedHtml",
};

const PASEO_ACTIVITY_ORDER: readonly PaseoActivity[] = [
  "sentPrompts",
  "sentNotes",
  "waitedForAgents",
  "checkedAgents",
  "listedAgents",
  "stoppedAgents",
  "archivedAgents",
  "answeredPermissions",
  "createdSchedules",
  "createdHeartbeats",
  "checkedCapabilities",
  "previewedHtml",
  "renderedHtml",
];

/** Activities whose count is the agents they touched rather than the calls made. */
const COUNTS_AGENTS: ReadonlySet<PaseoActivity> = new Set([
  "waitedForAgents",
  "checkedAgents",
  "stoppedAgents",
  "archivedAgents",
]);

export interface PaseoActivityCount {
  activity: PaseoActivity;
  count: number;
  /** Distinct agents the calls named; what "to N agents" reads from. */
  agentCount: number;
  /** Every call failed, so the phrase reads "tried to …". */
  failedOnly: boolean;
  /** The one agent every call named, so a note can read "to {title}". */
  soleAgentId?: string;
}

export interface OverviewSummary {
  editedFileCount: number;
  commandCount: number;
  readFileCount: number;
  searchCount: number;
  otherToolCount: number;
  paseoActivities: readonly PaseoActivityCount[];
  /** Paseo calls no activity names. */
  paseoCallCount: number;
}

export interface OverviewToolCallGroup {
  mode: "overview";
  run: ToolCallRun;
  summary: OverviewSummary;
  isLoading: boolean;
}

interface PaseoActivityTally {
  calls: number;
  failedCalls: number;
  agents: Set<string>;
}

function isPaseoCall(name: string, normalizedName: string): boolean {
  return (
    isPaseoToolName(name) ||
    normalizedName.startsWith(DIRECT_PASEO_TOOL_PREFIX) ||
    normalizedName === "html_preview" ||
    normalizedName === "html_render"
  );
}

function isSearchCall(name: string): boolean {
  return DIRECT_SEARCH_TOOL_SUFFIX_PATTERN.test(name);
}

function readAgentIds(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const agentId: unknown = Reflect.get(input, "agentId");
  if (typeof agentId === "string" && agentId) return [agentId];
  const agentIds: unknown = Reflect.get(input, "agentIds");
  if (!Array.isArray(agentIds)) return [];
  return agentIds.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** The tool's own result, out of the MCP envelope each provider reports it in. */
function unwrapMcpResult(output: unknown): unknown {
  if (typeof output !== "object" || output === null) return parseJsonText(output);
  const structured: unknown = Reflect.get(output, "structuredContent");
  if (structured !== undefined) return structured;
  const content: unknown = Reflect.get(output, "content");
  if (Array.isArray(content) && content.length === 1) {
    const block: unknown = content[0];
    if (typeof block === "object" && block !== null && Reflect.get(block, "type") === "text") {
      return parseJsonText(Reflect.get(block, "text"));
    }
  }
  const claudeOutput: unknown = Reflect.get(output, "output");
  return claudeOutput === undefined ? output : parseJsonText(claudeOutput);
}

/** `send_agent_prompt` to an agent that is not the caller's child went as a peer note. */
function isDeliveredAsPeerNote(output: unknown): boolean {
  const result = unwrapMcpResult(output);
  return (
    typeof result === "object" &&
    result !== null &&
    Reflect.get(result, "deliveredAs") === "peer_note"
  );
}

function resolvePaseoActivity(leaf: string | null, call: ToolCallItem): PaseoActivity | undefined {
  const activity = leaf ? PASEO_ACTIVITY_BY_LEAF[leaf] : undefined;
  if (activity !== "sentPrompts") return activity;
  const descriptor = describeToolCall(call);
  const output = descriptor.detail.type === "unknown" ? descriptor.detail.output : null;
  return isDeliveredAsPeerNote(output) ? "sentNotes" : activity;
}

function tallyPaseoActivity(
  tallies: Map<PaseoActivity, PaseoActivityTally>,
  activity: PaseoActivity,
  call: ToolCallItem,
): void {
  const descriptor = describeToolCall(call);
  const tally = tallies.get(activity) ?? { calls: 0, failedCalls: 0, agents: new Set<string>() };
  tally.calls += 1;
  if (descriptor.status === "failed") tally.failedCalls += 1;
  const input = descriptor.detail.type === "unknown" ? descriptor.detail.input : null;
  const agentIds = readAgentIds(input);
  // A call that names no agent still counts once, so it is never silently dropped.
  for (const agentId of agentIds.length > 0 ? agentIds : [`${UNNAMED_AGENT_PREFIX}${call.id}`]) {
    tally.agents.add(agentId);
  }
  tallies.set(activity, tally);
}

function toActivityCounts(
  tallies: ReadonlyMap<PaseoActivity, PaseoActivityTally>,
): PaseoActivityCount[] {
  return PASEO_ACTIVITY_ORDER.flatMap((activity) => {
    const tally = tallies.get(activity);
    if (!tally) return [];
    const agentCount = tally.agents.size;
    const [soleAgentId] = tally.agents;
    const hasSoleAgent =
      agentCount === 1 && soleAgentId && !soleAgentId.startsWith(UNNAMED_AGENT_PREFIX);
    return [
      {
        activity,
        count: COUNTS_AGENTS.has(activity) ? agentCount : tally.calls,
        agentCount,
        failedOnly: tally.failedCalls === tally.calls,
        ...(activity === "sentNotes" && hasSoleAgent ? { soleAgentId } : {}),
      },
    ];
  });
}

export function summarizeOverviewToolCalls(calls: readonly ToolCallItem[]): {
  summary: OverviewSummary;
  isLoading: boolean;
} {
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  const paseoTallies = new Map<PaseoActivity, PaseoActivityTally>();
  let isLoading = false;
  let commandCount = 0;
  let searchCount = 0;
  let otherToolCount = 0;
  let paseoCallCount = 0;

  for (const call of calls) {
    const descriptor = describeToolCall(call);
    const normalizedName = descriptor.name.trim().toLowerCase();
    isLoading ||= descriptor.status === "running" || descriptor.status === "executing";
    if (isSubagentSpawnCall(call)) {
      // Spawns render as subagent rows, so a summary repeating them would count them twice.
      continue;
    }
    if (isPaseoCall(descriptor.name, normalizedName)) {
      const leaf =
        normalizedName === "html_preview" || normalizedName === "html_render"
          ? normalizedName
          : getPaseoCallLeafName(descriptor.name);
      const activity = resolvePaseoActivity(leaf, call);
      if (activity) tallyPaseoActivity(paseoTallies, activity, call);
      else paseoCallCount += 1;
    } else if (descriptor.detail.type === "edit" || descriptor.detail.type === "write") {
      editedFiles.add(descriptor.detail.filePath);
    } else if (descriptor.detail.type === "shell") {
      commandCount += 1;
    } else if (descriptor.detail.type === "read") {
      readFiles.add(descriptor.detail.filePath);
    } else if (descriptor.detail.type === "search" || isSearchCall(normalizedName)) {
      searchCount += 1;
    } else {
      otherToolCount += 1;
    }
  }

  return {
    summary: {
      editedFileCount: editedFiles.size,
      commandCount,
      readFileCount: readFiles.size,
      searchCount,
      otherToolCount,
      paseoActivities: toActivityCounts(paseoTallies),
      paseoCallCount,
    },
    isLoading,
  };
}

export function buildOverviewGroup(run: ToolCallRun): OverviewToolCallGroup {
  const { summary, isLoading } = summarizeOverviewToolCalls(run.calls);
  return {
    mode: "overview",
    run,
    isLoading,
    summary,
  };
}
