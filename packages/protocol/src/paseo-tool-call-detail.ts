import { getPaseoCallLeafName, getPaseoToolLeafName } from "./tool-name-normalization.js";

export interface PaseoToolDetailField {
  label: string;
  value: string;
}

export type PaseoToolDetailSection =
  | {
      kind: "prose";
      title: string;
      text: string;
    }
  | {
      kind: "fields";
      title: string;
      fields: PaseoToolDetailField[];
    };

interface ToolDetailSpec {
  promptField?: string;
  inputOrder?: readonly string[];
  outputFields?: readonly string[];
}

const WORKSPACE_FIELDS = [
  "title",
  "workspaceId",
  "projectId",
  "isolation",
  "path",
  "mode",
  "worktreeSlug",
  "branchName",
  "baseBranch",
  "branch",
  "prNumber",
  "forge",
] as const;
const AGENT_FIELDS = [
  "title",
  "agentId",
  "provider",
  "workspaceId",
  "cwd",
  "sessionMode",
  "modeId",
  "background",
  "notifyOnFinish",
  "settings",
  "labels",
  "clientRequestId",
] as const;
const SEND_PROMPT_FIELDS = [
  "agentId",
  "delivery",
  "sessionMode",
  "background",
  "notifyOnFinish",
  "clientRequestId",
] as const;
const AUTOMATION_FIELDS = [
  "name",
  "id",
  "cron",
  "timezone",
  "provider",
  "cwd",
  "isolation",
  "maxRuns",
  "expiresIn",
  "clearExpires",
] as const;
const BROWSER_FIELDS = [
  "browserId",
  "url",
  "ref",
  "sourceRef",
  "targetRef",
  "value",
  "text",
  "key",
  "button",
  "doubleClick",
  "modifiers",
  "filePaths",
  "fullPage",
  "maxEntries",
  "timeoutMs",
  "deltaX",
  "deltaY",
  "width",
  "height",
  "function",
] as const;

const TOOL_SPECS: Readonly<Record<string, ToolDetailSpec>> = {
  create_workspace: {
    inputOrder: WORKSPACE_FIELDS,
    outputFields: ["workspaceId", "projectId"],
  },
  list_workspaces: {},
  archive_workspace: {
    inputOrder: ["workspaceId"],
    outputFields: ["workspaceId", "archivedAgentIds", "removedDirectory"],
  },
  rename_workspace: { inputOrder: ["title", "workspaceId"] },
  create_agent: {
    promptField: "initialPrompt",
    inputOrder: AGENT_FIELDS,
    outputFields: ["agentId", "status", "currentModeId", "cwd", "deduplicated"],
  },
  send_agent_prompt: {
    promptField: "prompt",
    inputOrder: SEND_PROMPT_FIELDS,
    outputFields: ["disposition", "status", "lastMessage", "permission"],
  },
  wait_for_agent: {
    inputOrder: ["agentId", "timeoutMs"],
    outputFields: ["status", "timedOut", "lastMessage", "permission", "delegatedTask"],
  },
  get_orchestration_capabilities: {
    inputOrder: ["provider", "includeModels"],
    outputFields: ["limits", "features"],
  },
  watch_pull_request: {
    inputOrder: ["number", "url"],
    outputFields: ["number", "title", "wasWatching", "checks", "conflicting"],
  },
  unwatch_pull_request: { inputOrder: ["number", "url"], outputFields: ["wasWatching"] },
  get_agent_status: { inputOrder: ["agentId"], outputFields: ["status", "delegatedTask"] },
  list_agents: {
    inputOrder: [
      "scope",
      "parentAgentId",
      "titleContains",
      "cwd",
      "statuses",
      "sinceHours",
      "limit",
      "includeArchived",
    ],
  },
  cancel_agent: { inputOrder: ["agentId"], outputFields: ["status"] },
  archive_agent: { inputOrder: ["agentId"] },
  kill_agent: { inputOrder: ["agentId"] },
  update_agent: { inputOrder: AGENT_FIELDS },
  get_agent_activity: {
    inputOrder: [
      "agentId",
      "view",
      "limit",
      "afterPosition",
      "epoch",
      "itemPosition",
      "textOffset",
      "maxCharsPerItem",
    ],
    outputFields: ["content", "items", "nextPosition", "hasMore", "hasOlder", "reset"],
  },
  set_agent_mode: { inputOrder: ["agentId", "modeId"] },
  list_workspace_scripts: { inputOrder: ["workspaceId"] },
  start_workspace_script: { inputOrder: ["workspaceId", "scriptName"] },
  stop_workspace_script: { inputOrder: ["workspaceId", "scriptName"] },
  list_terminals: { inputOrder: ["cwd", "all"] },
  create_terminal: { inputOrder: ["cwd", "workspaceId", "name", "command"] },
  kill_terminal: { inputOrder: ["terminalId"] },
  capture_terminal: { inputOrder: ["terminalId", "lines"] },
  send_terminal_keys: { inputOrder: ["terminalId", "keys", "literal"] },
  create_schedule: {
    promptField: "prompt",
    inputOrder: AUTOMATION_FIELDS,
    outputFields: ["id", "status", "nextRunAt", "expiresAt"],
  },
  create_heartbeat: {
    promptField: "prompt",
    inputOrder: AUTOMATION_FIELDS,
    outputFields: ["id", "status", "nextRunAt", "expiresAt"],
  },
  delete_heartbeat: { inputOrder: ["id"] },
  list_schedules: {},
  inspect_schedule: { inputOrder: ["id"] },
  pause_schedule: { inputOrder: ["id"] },
  resume_schedule: { inputOrder: ["id"] },
  delete_schedule: { inputOrder: ["id"] },
  update_schedule: { promptField: "prompt", inputOrder: AUTOMATION_FIELDS },
  schedule_logs: { inputOrder: ["id"] },
  run_schedule_once: { inputOrder: ["id"] },
  list_providers: {},
  list_models: { inputOrder: ["provider"] },
  list_profiles: {},
  inspect_provider: { inputOrder: ["provider", "cwd", "settings"] },
  list_pending_permissions: {},
  respond_to_permission: { inputOrder: ["agentId", "requestId", "response"] },
  browser_list_tabs: {},
  browser_new_tab: { inputOrder: BROWSER_FIELDS },
  browser_snapshot: { inputOrder: BROWSER_FIELDS },
  browser_click: { inputOrder: BROWSER_FIELDS },
  browser_fill: { inputOrder: BROWSER_FIELDS },
  browser_wait: { inputOrder: BROWSER_FIELDS },
  browser_type: { inputOrder: BROWSER_FIELDS },
  browser_keypress: { inputOrder: BROWSER_FIELDS },
  browser_navigate: { inputOrder: BROWSER_FIELDS },
  browser_back: { inputOrder: BROWSER_FIELDS },
  browser_forward: { inputOrder: BROWSER_FIELDS },
  browser_reload: { inputOrder: BROWSER_FIELDS },
  browser_screenshot: { inputOrder: BROWSER_FIELDS },
  browser_upload: { inputOrder: BROWSER_FIELDS },
  browser_hover: { inputOrder: BROWSER_FIELDS },
  browser_select: { inputOrder: BROWSER_FIELDS },
  browser_drag: { inputOrder: BROWSER_FIELDS },
  browser_logs: { inputOrder: BROWSER_FIELDS },
  browser_evaluate: { inputOrder: BROWSER_FIELDS },
  browser_scroll: { inputOrder: BROWSER_FIELDS },
  browser_resize: { inputOrder: BROWSER_FIELDS },
  browser_close_tab: { inputOrder: BROWSER_FIELDS },
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  afterPosition: "After position",
  agentId: "Agent",
  archivedAgentIds: "Archived agents",
  baseBranch: "Base branch",
  branchName: "New branch",
  browserId: "Browser tab",
  clearExpires: "Clear expiry",
  clientRequestId: "Retry key",
  currentModeId: "Current mode",
  cwd: "Working directory",
  deltaX: "Horizontal delta",
  deltaY: "Vertical delta",
  delegatedTask: "Delegated result",
  delivery: "If the agent is busy",
  disposition: "Outcome",
  doubleClick: "Double click",
  expiresIn: "Expires in",
  expiresAt: "Expires",
  filePaths: "Files",
  fullPage: "Full page",
  hasMore: "More after this page",
  hasOlder: "Older entries",
  includeModels: "Include models",
  initialPrompt: "Prompt",
  id: "ID",
  itemPosition: "Item position",
  lastMessage: "Last message",
  maxCharsPerItem: "Characters per item",
  maxEntries: "Maximum entries",
  maxRuns: "Maximum runs",
  modeId: "Mode",
  number: "Pull request",
  newMode: "New mode",
  nextPosition: "Next position",
  nextRunAt: "Next run",
  notifyOnFinish: "Notify on finish",
  parentAgentId: "Parent agent",
  prNumber: "Change request",
  projectId: "Project",
  removedDirectory: "Removed directory",
  requestId: "Request",
  scriptName: "Script",
  sessionMode: "Session mode",
  sinceHours: "Since (hours)",
  sourceRef: "Source",
  targetRef: "Target",
  taskId: "Task",
  terminalId: "Terminal",
  textOffset: "Text offset",
  thinkingOptionId: "Thinking",
  timedOut: "Timed out",
  timeoutMs: "Timeout (ms)",
  titleContains: "Title contains",
  updateCount: "Updates",
  wasWatching: "Already watching",
  workspaceId: "Workspace",
  worktreeSlug: "Worktree",
};

/** Enum values a person reads differently from the wire, per top-level field. */
const FIELD_VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  delivery: {
    auto: "Steer, or run after its turn",
    queue: "Run after its turn",
    steer: "Steer into its turn",
    restart: "Interrupt and restart",
  },
  disposition: {
    started: "Started a turn",
    steered: "Steered into the running turn",
    queued: "Runs after the running turn",
    restarted: "Interrupted and restarted",
    out_of_band: "Sent outside a turn",
    duplicate: "Already sent",
  },
  scope: {
    cwd: "Working directory",
    children: "My subagents",
    workspace: "Workspace",
    project: "Project",
    all: "All agents",
  },
  status: {
    cancel_requested: "Cancel requested",
    not_running: "Not running",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeKey(key: string): string {
  const known = FIELD_LABELS[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const sentence = words.join(" ").toLowerCase();
  return `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}

function formatValue(value: unknown, depth = 0): string {
  if (value === null) return "None";
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    return value.map((item) => `• ${indentMultiline(formatValue(item, depth + 1), 2)}`).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    if (entries.length === 0) return "None";
    return entries
      .map(([key, child]) => {
        const formatted = formatValue(child, depth + 1);
        return `${humanizeKey(key)}: ${indentMultiline(formatted, 2)}`;
      })
      .join("\n");
  }
  return String(value);
}

function formatFieldValue(key: string, value: unknown): string {
  const label = typeof value === "string" ? FIELD_VALUE_LABELS[key]?.[value] : undefined;
  return label ?? formatValue(value);
}

function indentMultiline(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return value.replace(/\n/g, `\n${indentation}`);
}

function orderedEntries(
  value: Record<string, unknown>,
  order: readonly string[] = [],
  omittedKey?: string,
  includedKeys?: readonly string[],
): Array<[string, unknown]> {
  const included = includedKeys ? new Set(includedKeys) : null;
  const keys = Object.keys(value).filter(
    (key) => key !== omittedKey && value[key] !== undefined && (!included || included.has(key)),
  );
  const rank = new Map(order.map((key, index) => [key, index]));
  keys.sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
  return keys.map((key) => [key, value[key]]);
}

function fieldsFromValue(
  value: unknown,
  order?: readonly string[],
  omittedKey?: string,
  includedKeys?: readonly string[],
): PaseoToolDetailField[] {
  if (value === null || value === undefined) return [];
  if (!isRecord(value)) {
    const formatted = formatValue(value);
    return formatted ? [{ label: "Value", value: formatted }] : [];
  }
  return orderedEntries(value, order, omittedKey, includedKeys).map(([key, child]) => ({
    label: humanizeKey(key),
    value: formatFieldValue(key, child),
  }));
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function unwrapMcpResult(output: unknown): unknown {
  if (!isRecord(output)) return output;

  if (output.structuredContent !== undefined) {
    return output.structuredContent;
  }

  if (Array.isArray(output.content) && output.content.length === 1) {
    const item = output.content[0];
    if (isRecord(item) && item.type === "text") {
      return parseJsonText(item.text) ?? item.text;
    }
  }

  // Claude reports an MCP result as `{ output: <parsed text> }` (plus `files` when it tracked edits).
  if (
    output.output !== undefined &&
    Object.keys(output).every((key) => key === "output" || key === "files")
  ) {
    return parseJsonText(output.output) ?? output.output;
  }

  return output;
}

/** The agent a completed `create_agent` call created, read from its MCP result. */
export function resolvePaseoSpawnedAgentId(toolName: string, output: unknown): string | null {
  if (getPaseoCallLeafName(toolName) !== "create_agent") return null;
  const result = unwrapMcpResult(output);
  if (!isRecord(result)) return null;
  const agentId = result.agentId;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : null;
}

export function buildPaseoToolDetailSections(
  toolName: string,
  input: unknown,
  output: unknown,
): PaseoToolDetailSection[] | null {
  const leafName = getPaseoToolLeafName(toolName);
  if (!leafName) return null;

  const spec = TOOL_SPECS[leafName] ?? {};
  const sections: PaseoToolDetailSection[] = [];
  if (spec.promptField && isRecord(input)) {
    const prompt = input[spec.promptField];
    if (typeof prompt === "string" && prompt.length > 0) {
      sections.push({ kind: "prose", title: "Prompt", text: prompt });
    }
  }

  const inputFields = fieldsFromValue(input, spec.inputOrder, spec.promptField);
  if (inputFields.length > 0) {
    sections.push({ kind: "fields", title: "Details", fields: inputFields });
  }

  const outputFields = fieldsFromValue(
    unwrapMcpResult(output),
    spec.outputFields,
    undefined,
    spec.outputFields,
  );
  if (outputFields.length > 0) {
    sections.push({ kind: "fields", title: "Result", fields: outputFields });
  }
  return sections;
}
