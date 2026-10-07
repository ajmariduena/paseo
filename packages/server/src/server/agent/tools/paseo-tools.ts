import { createHash, randomUUID } from "node:crypto";
import { HtmlRenderStore, MAX_HTML_CHARS } from "../html-render/store.js";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { ensureValidJson } from "../../json-utils.js";
import type { Logger } from "pino";

import type {
  AgentMode,
  AgentPermissionRequest,
  AgentProvider,
  AgentSessionConfig,
  ProviderSnapshotEntry,
} from "../agent-sdk-types.js";
import type { AgentManager } from "../agent-manager.js";
import { AgentProfileSchema } from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import {
  AgentFeatureSchema,
  AgentPermissionRequestPayloadSchema,
  AgentListItemPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
  WorkspaceScriptPayloadSchema,
} from "../../messages.js";
import type { AgentListItemPayload, AgentSnapshotPayload } from "../../messages.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  buildStoredAgentPayload,
  toAgentListItemPayload,
  toAgentPayload,
} from "../agent-projections.js";
import { curateAgentActivity } from "../activity-curator.js";
import {
  DEFAULT_ACTIVITY_PAGE_LIMIT,
  DEFAULT_MAX_CHARS_PER_ITEM,
  MAX_ACTIVITY_PAGE_LIMIT,
  MAX_CHARS_PER_ITEM,
  readActivityPage,
  type ActivityPage,
  type ActivityView,
} from "../activity-page.js";
import { selectItemsByProjectedLimit } from "../timeline-projection.js";
import type { AgentCreationRequest, AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { isStoredAgentProviderAvailable } from "../../persistence-hooks.js";
import {
  archiveByScope,
  killTerminalsForWorkspace,
  requireActiveWorkspaceForArchive,
  type ArchiveDependencies,
} from "../../workspace-archive-service.js";
import { createAgentCommand, type CreateAgentFromMcpInput } from "../create-agent/create.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../../voice-types.js";
import type { FirstAgentContext } from "../../messages.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";
import { expandUserPath, isSameOrDescendantPath, resolvePathFromBase } from "../../path-utils.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeWorkflowFn } from "../../worktree-session.js";
import type { ScheduleService } from "../../schedule/service.js";
import {
  ScheduleRunSchema,
  ScheduleSummarySchema,
  StoredScheduleSchema,
  type ScheduleCadence,
  type UpdateScheduleInput,
} from "@getpaseo/protocol/schedule/types";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  AgentModelSchema,
  AgentProviderEnum,
  AgentStatusEnum,
  ProviderModeSchema,
  ProviderSummarySchema,
  parseDurationString,
  resolveRequiredProviderModel,
  sanitizePermissionRequest,
  serializeSnapshotWithMetadata,
  toScheduleSummary,
  AGENT_WAIT_TIMEOUT_MS,
  DEFAULT_AGENT_WAIT_MS,
  MAX_AGENT_WAIT_MS,
  UNVERIFIED_CLIENT_MAX_WAIT_MS,
  waitForAgentWithTimeout,
} from "../mcp-shared.js";
import { prepareAgentForPrompt, waitForAgentRunStartWithTimeout } from "../agent-prompt.js";
import {
  dispatchAgentMessageInBackground,
  isMessageAlreadyDispatched,
  SteerUnavailableError,
  type BackgroundDispatch,
  type DispatchIntent,
} from "../message-dispatch.js";
import type { DelegationService } from "../../delegation/delegation-service.js";
import type { PullRequestWatcher } from "../../pull-request-watch/watcher.js";
import { respondToAgentPermission } from "../permission-response.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
} from "../lifecycle-command.js";
import type { ForgeService } from "../../../services/forge-service.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type {
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../../workspace-registry.js";
import { resolveWorktreeSourceCwd } from "../../workspace-source.js";
import type { WorkspaceScriptsService } from "../../session/workspace-scripts/workspace-scripts-service.js";
import {
  type ArchiveCommandDependencies,
  type CreatePaseoWorktreeCommandInput,
  createPaseoWorktreeCommand,
} from "../../worktree/commands.js";
import { registerBrowserTools } from "../../browser-tools/tools.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import type {
  PaseoToolCatalog,
  PaseoToolConfig,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
  PaseoToolResult,
  PaseoToolRuntimeContext,
} from "./types.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./read-only-tools.js";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import { isPaseoToolEnabled } from "../paseo-tool-policy.js";

export interface PaseoToolHostDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager?: TerminalManager | null;
  getDaemonTcpPort?: () => number | null;
  scheduleService?: ScheduleService | null;
  providerSnapshotManager: ProviderSnapshotManager;
  daemonConfigStore?: Pick<DaemonConfigStore, "get">;
  github?: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
  >;
  findWorkspaceIdForCwd?: ArchiveDependencies["findWorkspaceIdForCwd"];
  listActiveWorkspaces?: ArchiveDependencies["listActiveWorkspaces"];
  archiveWorkspaceRecord?: ArchiveDependencies["archiveWorkspaceRecord"];
  emitWorkspaceUpdatesForWorkspaceIds?: ArchiveDependencies["emitWorkspaceUpdatesForWorkspaceIds"];
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "list" | "upsert">;
  projectRegistry?: Pick<ProjectRegistry, "get" | "list">;
  createDirectoryWorkspace?: (
    cwd: string,
    title?: string | null,
    projectId?: string,
  ) => Promise<PersistedWorkspaceRecord>;
  workspaceScripts?: Pick<WorkspaceScriptsService, "list" | "launch" | "stop">;
  markWorkspaceArchiving?: ArchiveDependencies["markWorkspaceArchiving"];
  clearWorkspaceArchiving?: ArchiveDependencies["clearWorkspaceArchiving"];
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<string>;
  browserToolsEnabled?: boolean;
  browserToolsBroker?: BrowserToolsBroker | null;
  paseoToolPolicy?: ProviderPaseoToolsPolicy;
  paseoHome?: string;
  worktreesRoot?: string;
  delegations?: Pick<
    DelegationService,
    | "delegate"
    | "acknowledgeChildResults"
    | "disposeChildTasks"
    | "refreshChild"
    | "beginWait"
    | "endWait"
    | "waitForChildResult"
  >;
  pullRequestWatches?: Pick<PullRequestWatcher, "watch" | "unwatch">;
  transport?: PaseoToolRuntimeContext["transport"];
  /**
   * ID of the agent that is using this tool catalog.
   * Used for cwd/mode inheritance when agents spawn child agents.
   */
  callerAgentId?: string;
  /**
   * Optional resolver for session-bound speak handlers.
   * Used by hidden voice agents to narrate through daemon-managed TTS.
   */
  resolveSpeakHandler?: (callerAgentId: string) => VoiceSpeakHandler | null;
  resolveCallerContext?: (callerAgentId: string) => VoiceCallerContext | null;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
  logger: Logger;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveAgentListActivityTime(agent: AgentListItemPayload): number {
  return Math.max(
    parseTimestamp(agent.updatedAt),
    parseTimestamp(agent.lastUserMessageAt),
    parseTimestamp(agent.attentionTimestamp),
    parseTimestamp(agent.archivedAt),
    parseTimestamp(agent.createdAt),
  );
}

interface ProviderSummary {
  id: AgentProvider;
  label: string;
  description: string;
  enabled: boolean;
  modes: AgentMode[];
  status: string;
  error?: string;
}

const WorkspaceAutomationSummarySchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  isolation: z.enum(["local", "worktree"]),
  kind: z.enum(["directory", "local_checkout", "worktree"]),
  title: z.string().nullable(),
});

function toWorkspaceAutomationSummary(workspace: PersistedWorkspaceRecord) {
  return {
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    isolation: workspace.kind === "worktree" ? ("worktree" as const) : ("local" as const),
    kind: workspace.kind,
    title: workspace.title,
  };
}

type WorkspaceWorktreeMode = "branch-off" | "checkout-branch" | "checkout-pr";

interface WorkspaceWorktreeOptions {
  mode?: WorkspaceWorktreeMode;
  worktreeSlug?: string;
  branchName?: string;
  baseBranch?: string;
  branch?: string;
  prNumber?: number;
  forge?: string;
}

type WorkspaceWorktreeTarget = Pick<
  CreatePaseoWorktreeCommandInput,
  "action" | "branchName" | "refName" | "checkoutSource"
>;

function assertOptionsAbsent(
  options: Array<[name: string, value: unknown]>,
  message: string,
): void {
  if (options.some(([, value]) => value !== undefined)) {
    throw new Error(message);
  }
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function resolveWorkspaceWorktreeTarget(input: WorkspaceWorktreeOptions): WorkspaceWorktreeTarget {
  switch (input.mode ?? "branch-off") {
    case "branch-off":
      assertOptionsAbsent(
        [
          ["branch", input.branch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branch, prNumber, and forge require a checkout mode",
      );
      return {
        action: "branch-off",
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.baseBranch ? { refName: input.baseBranch } : {}),
      };
    case "checkout-branch":
      if (!input.branch) {
        throw new Error("branch is required for checkout-branch mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branchName, baseBranch, prNumber, and forge are not valid for checkout-branch mode",
      );
      return { action: "checkout", refName: input.branch };
    case "checkout-pr":
      if (input.prNumber === undefined) {
        throw new Error("prNumber is required for checkout-pr mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["branch", input.branch],
        ],
        "branchName, baseBranch, and branch are not valid for checkout-pr mode",
      );
      return {
        action: "checkout",
        checkoutSource: {
          kind: "change_request",
          ...(input.forge ? { forge: input.forge } : {}),
          number: input.prNumber,
        },
      };
  }
}

function toProviderSummary(entry: {
  provider: AgentProvider;
  label?: string;
  description?: string;
  enabled: boolean;
  modes?: AgentMode[];
  status: string;
  error?: string;
}): ProviderSummary {
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? "",
    enabled: entry.enabled,
    modes: entry.modes ?? [],
    status: entry.status === "ready" ? "available" : entry.status,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function compareAgentListItems(a: AgentListItemPayload, b: AgentListItemPayload): number {
  const attentionDelta =
    Number(b.requiresAttention ?? false) - Number(a.requiresAttention ?? false);
  if (attentionDelta !== 0) {
    return attentionDelta;
  }

  const statusOrder = {
    running: 0,
    initializing: 1,
    idle: 2,
    error: 3,
    closed: 4,
  } as Record<string, number>;
  const statusDelta = (statusOrder[a.status] ?? 999) - (statusOrder[b.status] ?? 999);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  return resolveAgentListActivityTime(b) - resolveAgentListActivityTime(a);
}

function resolveScheduleProviderAndModel(params: {
  provider?: string;
  defaultProvider: AgentProvider;
}): { provider: AgentProvider; model?: string } {
  const providerInput = params.provider?.trim() || params.defaultProvider;
  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return { provider: providerInput };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const model = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }

  return {
    provider: provider,
    model,
  };
}

function resolveScheduleUpdateProviderAndModel(params: {
  provider?: string;
  model?: string | null;
}): { provider?: string; model?: string | null } {
  const providerInput = params.provider?.trim();
  const modelInput = typeof params.model === "string" ? params.model.trim() : params.model;

  if (params.model !== undefined && modelInput === "") {
    throw new Error("model cannot be empty");
  }

  if (!providerInput) {
    return params.model !== undefined ? { model: modelInput } : {};
  }

  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return {
      provider: providerInput,
      ...(params.model !== undefined ? { model: modelInput } : {}),
    };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const modelFromProvider = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !modelFromProvider) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }
  if (params.model === null) {
    throw new Error("provider specifies a model but model is null");
  }
  if (typeof modelInput === "string" && modelInput !== modelFromProvider) {
    throw new Error("Conflicting model values provided");
  }

  return {
    provider,
    model: modelInput ?? modelFromProvider,
  };
}

interface ScheduleUpdateToolInput {
  id: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string | null;
  prompt?: string;
  maxRuns?: number | null;
  provider?: string;
  model?: string | null;
  mode?: string | null;
  cwd?: string;
  expiresIn?: string;
  clearExpires?: boolean;
}

function normalizeScheduleCadenceArg(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function normalizeScheduleTimeZoneArg(value: string | undefined): string | undefined {
  return normalizeScheduleCadenceArg(value);
}

function resolveScheduleUpdateCadence(input: ScheduleUpdateToolInput): ScheduleCadence | undefined {
  const every = normalizeScheduleCadenceArg(input.every);
  const cron = normalizeScheduleCadenceArg(input.cron);
  const timeZone = normalizeScheduleTimeZoneArg(input.timezone);

  if (every !== undefined && cron !== undefined) {
    throw new Error("Specify at most one of every or cron");
  }
  if (timeZone !== undefined && cron === undefined) {
    throw new Error("timezone can only be used with cron");
  }
  if (every !== undefined) {
    // COMPAT(scheduleEveryInput): accept the old hidden field and canonicalize it before write.
    // Added in v0.2.0; remove after 2027-01-17.
    const everyMs = parseDurationString(every);
    const expression = everyMsToFiveFieldCron(everyMs);
    if (expression) {
      return { type: "cron", expression };
    }
    throw new Error(`${every} cannot be represented faithfully by five-field cron`);
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron,
      ...(timeZone !== undefined ? { timezone: timeZone } : {}),
    };
  }
  return undefined;
}

function resolveScheduleUpdateExpiresAt(input: ScheduleUpdateToolInput): string | null | undefined {
  if (input.expiresIn !== undefined && input.clearExpires) {
    throw new Error("Specify at most one of expiresIn or clearExpires");
  }
  if (input.expiresIn !== undefined) {
    return new Date(Date.now() + parseDurationString(input.expiresIn)).toISOString();
  }
  if (input.clearExpires) {
    return null;
  }
  return undefined;
}

function buildScheduleUpdateInput(input: ScheduleUpdateToolInput): UpdateScheduleInput {
  const cadence = resolveScheduleUpdateCadence(input);
  const expiresAt = resolveScheduleUpdateExpiresAt(input);
  const providerModelPatch = resolveScheduleUpdateProviderAndModel({
    provider: input.provider,
    model: input.model,
  });
  const newAgentConfig = {
    ...(providerModelPatch.provider !== undefined ? { provider: providerModelPatch.provider } : {}),
    ...(providerModelPatch.model !== undefined ? { model: providerModelPatch.model } : {}),
    ...(input.mode !== undefined ? { modeId: input.mode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };

  return {
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(Object.keys(newAgentConfig).length > 0 ? { newAgentConfig } : {}),
  };
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

const TerminalSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});

function resolveTerminalKeyToken(key: string, literal: boolean): string {
  if (literal) {
    return key;
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}

const DelegatedTaskResultSchema = z.object({
  taskId: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "interrupted"]),
  result: z.string().nullable(),
  resultTruncated: z.boolean(),
});

/** Reported for parity with T3's cap; Paseo does not enforce it yet. */
const MAX_PROMPT_CHARS = 120_000;

const OrchestrationCapabilitiesSchema = {
  caller: z
    .object({
      agentId: z.string(),
      provider: z.string(),
      extends: z.string().nullable(),
      model: z.string().nullable(),
      modeId: z.string().nullable(),
      workspaceId: z.string().nullable(),
    })
    .nullable(),
  providers: z.array(
    z.object({
      id: z.string(),
      extends: z.string().nullable(),
      label: z.string().nullable(),
      status: z.string(),
      canRunChild: z.boolean(),
      constraints: z.array(z.string()),
      defaultModelId: z.string().nullable(),
      defaultModeId: z.string().nullable(),
      modes: z.array(z.object({ id: z.string(), label: z.string(), unattended: z.boolean() })),
      models: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            isDefault: z.boolean(),
            thinkingOptionIds: z.array(z.string()),
            defaultThinkingOptionId: z.string().nullable(),
          }),
        )
        .optional(),
    }),
  ),
  agentProfiles: z.array(AgentProfileSchema),
  limits: z.object({
    maxWaitMs: z.number(),
    defaultWaitMs: z.number(),
    maxPromptChars: z.number(),
  }),
  features: z.record(z.string(), z.boolean()),
};

/** Providers whose MCP client Paseo configures to allow a full wait_for_agent call. */
const RAISED_TOOL_TIMEOUT_PROVIDERS = new Set(["claude", "codex"]);

interface ListAgentsArgs {
  includeArchived?: boolean;
  cwd?: string;
  sinceHours?: number;
  statuses?: Array<z.infer<typeof AgentStatusEnum>>;
  limit?: number;
  scope?: "cwd" | "children" | "workspace" | "project" | "all";
  parentAgentId?: string;
  titleContains?: string;
}

interface GetAgentActivityArgs {
  agentId: string;
  limit?: number;
  view?: ActivityView;
  afterPosition?: number;
  epoch?: string;
  maxCharsPerItem?: number;
  itemPosition?: number;
  textOffset?: number;
}

function describeActivityPage(page: ActivityPage): string {
  const first = page.items[0]?.position;
  const last = page.items.at(-1)?.position;
  const range =
    first === undefined ? "No items" : `${page.items.length} items at positions ${first}-${last}`;
  const more = page.hasMore
    ? `; more after: pass afterPosition ${page.nextPosition}`
    : "; no newer items";
  return `${range}${more}.`;
}

type SendDisposition = "started" | "steered" | "queued" | "restarted" | "out_of_band" | "duplicate";

function toSendDisposition(disposition: BackgroundDispatch["disposition"]): SendDisposition {
  switch (disposition) {
    case "started":
    case "steered":
    case "queued":
    case "restarted":
    case "out_of_band":
      return disposition;
    case "dropped":
    case "skipped_archived":
      throw new Error(`Prompt was not delivered (${disposition})`);
  }
}

/** Retry keys are scoped per caller, so two agents reusing a key never collide. */
function deriveClientMessageId(callerAgentId: string | undefined, clientRequestId: string): string {
  const digest = createHash("sha256").update(clientRequestId).digest("hex");
  return `mcp:${callerAgentId ?? "top-level"}:${digest}`;
}

const createRequestTails = new WeakMap<AgentStorage, Map<string, Promise<unknown>>>();

/** Retries of one create request run one at a time, so the second finds the first's agent. */
async function serializeCreateRequest<T>(
  agentStorage: AgentStorage,
  creation: AgentCreationRequest,
  run: () => Promise<T>,
): Promise<T> {
  const tails = createRequestTails.get(agentStorage) ?? new Map<string, Promise<unknown>>();
  createRequestTails.set(agentStorage, tails);
  const key = JSON.stringify([creation.callerAgentId, creation.clientRequestId]);
  const result = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  tails.set(key, result);
  try {
    return await result;
  } finally {
    if (tails.get(key) === result) tails.delete(key);
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true).catch(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export function createPaseoToolCatalog(options: PaseoToolHostDependencies): PaseoToolCatalog {
  const {
    agentManager,
    agentStorage,
    terminalManager,
    workspaceScripts,
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    callerAgentId,
    resolveSpeakHandler,
    resolveCallerContext,
    logger,
  } = options;
  const childLogger = logger.child({ module: "agent", component: "paseo-tool-catalog" });
  const callerContext = callerAgentId ? (resolveCallerContext?.(callerAgentId) ?? null) : null;

  const parseToolInput = async (tool: PaseoToolDefinition, input: unknown): Promise<unknown> => {
    const inputSchema = tool.inputSchema;
    if (!inputSchema) {
      return input;
    }
    const schema =
      typeof inputSchema === "object" &&
      inputSchema !== null &&
      typeof (inputSchema as { safeParseAsync?: unknown }).safeParseAsync === "function"
        ? (inputSchema as z.ZodType)
        : z.object(inputSchema as z.ZodRawShape).passthrough();
    return schema.parseAsync(input);
  };

  const tools = new Map<string, PaseoToolDefinition>();
  const registerTool = (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => {
    if (!isPaseoToolEnabled(options.paseoToolPolicy, name)) {
      return;
    }
    tools.set(name, {
      name,
      title: config.title,
      description: config.description ?? name,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      ...(config.annotations ? { annotations: config.annotations } : {}),
      handler: handler as PaseoToolDefinition["handler"],
    });
  };
  const toCatalog = (): PaseoToolCatalog => ({
    tools,
    getTool(name: string): PaseoToolDefinition | undefined {
      return tools.get(name);
    },
    async executeTool(
      name: string,
      input: unknown,
      context: PaseoToolExecutionContext = {},
    ): Promise<PaseoToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Paseo tool not found: ${name}`);
      }
      return tool.handler(await parseToolInput(tool, input), context);
    },
  });

  if (callerAgentId && options.paseoHome && !options.voiceOnly) {
    registerTool(
      "html_render",
      {
        title: "Render an HTML page",
        description:
          "Show a finished self-contained HTML page (chart, dashboard, table, diagram, collage, mockup) inline above your final reply. Call before the reply; add only what the page does not say. Supply one document with inline style and script, a short title, and a height of 80–2000 CSS pixels. The frame is borderless and aligned with reply text. Use fluid width, no outer card or banner, and avoid viewport heights. Absolute local image paths under this agent's cwd or the OS temp directory are inlined. HTTPS scripts, styles, images, fonts, and media can load from any host, including chart CDNs, and can send data present in the page to that host. connect-src blocks fetch, XHR, and WebSocket only; it is not network isolation. Forms and nested frames are blocked. The page contains only what you author, and you already have that data and network access. Use CSS variables --background, --foreground, --muted, --muted-foreground, --card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring, --primary, --primary-foreground, --accent, --accent-foreground, --accent-surface, --accent-surface-foreground, --destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface, --success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground, --chart-1 through --chart-6, --radius, --font-sans and --font-mono. They follow the reader's theme live.",
        inputSchema: {
          html: z
            .string()
            .min(1)
            .max(MAX_HTML_CHARS)
            .describe("Complete self-contained HTML document"),
          title: z.string().trim().min(1).max(200).describe("Short name for the page"),
          height: z.number().int().describe("Initial frame height in CSS pixels, 80–2000"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input: { html: string; title: string; height: number }) => {
        const agent = resolveCallerAgent();
        if (!agent) throw new Error("html_render requires an agent caller");
        const htmlRender = await new HtmlRenderStore(options.paseoHome!).publish({
          agentId: agent.id,
          cwd: agent.cwd,
          ...input,
        });
        const result = {
          htmlRender,
          message:
            "Shown to the reader above your reply. Reply with only what the page does not already say.",
        };
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      },
    );
  }

  const buildCronScheduleCadence = (input: {
    cron: string | undefined;
    timezone?: string;
  }): ScheduleCadence => {
    const expression = input.cron?.trim() ?? "";
    if (!expression) {
      throw new Error("cron is required");
    }
    const timezone = normalizeScheduleTimeZoneArg(input.timezone);
    return {
      type: "cron",
      expression,
      ...(timezone !== undefined ? { timezone } : {}),
    };
  };

  const buildScheduleExpiry = (expiresIn: string | undefined): string | undefined => {
    return expiresIn === undefined
      ? undefined
      : new Date(Date.now() + parseDurationString(expiresIn)).toISOString();
  };

  const resolveCallerAgent = () => {
    if (!callerAgentId) {
      return null;
    }
    const parentAgent = agentManager.getAgent(callerAgentId);
    if (!parentAgent) {
      throw new Error(`Parent agent ${callerAgentId} not found`);
    }
    return parentAgent;
  };

  const resolveInheritedProviderConfig = (
    selectedProvider: string,
  ): Pick<AgentSessionConfig, "providerOptions"> | undefined => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent?.provider !== selectedProvider || !callerAgent.config?.providerOptions) {
      return undefined;
    }
    return { providerOptions: callerAgent.config.providerOptions };
  };

  const resolveScopedCwd = (requestedCwd?: string, opts?: { required?: boolean }): string => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent && callerContext?.actsForUser && !requestedCwd?.trim()) {
      throw new Error(
        "Pass path: the checkout of the project the user means (see list_workspaces). You have no workspace of your own to default to.",
      );
    }
    if (callerAgent) {
      return resolveChildAgentCwd({
        parentCwd: callerAgent.cwd,
        requestedCwd,
        lockedCwd: callerContext?.lockedCwd,
        allowCustomCwd: callerContext?.allowCustomCwd ?? true,
      });
    }

    const trimmedCwd = requestedCwd?.trim();
    if (!trimmedCwd) {
      if (opts?.required) {
        throw new Error("cwd is required");
      }
      throw new Error("cwd is required outside an agent-scoped session");
    }

    return expandUserPath(trimmedCwd);
  };

  async function resolveTerminalWorkspaceId(resolvedCwd: string): Promise<string> {
    // An agent-spawned terminal belongs to the caller agent's workspace. Only if
    // the caller has no workspace do we mint one for the cwd.
    const callerAgent = callerAgentId ? agentManager.getAgent(callerAgentId) : null;
    if (callerAgent?.workspaceId) {
      return callerAgent.workspaceId;
    }

    if (!options.ensureWorkspaceForCreate) {
      throw new Error(
        callerAgentId
          ? `Caller agent ${callerAgentId} has no workspace and workspace minting is not configured`
          : "workspaceId is required outside an agent-scoped session",
      );
    }

    return options.ensureWorkspaceForCreate(resolvedCwd);
  }

  function resolveWorkspaceIdForRename(requestedWorkspaceId?: string): string {
    const explicitWorkspaceId = requestedWorkspaceId?.trim();
    if (explicitWorkspaceId) {
      return explicitWorkspaceId;
    }

    if (callerAgentId) {
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
      }
      return callerAgent.workspaceId;
    }
    throw new Error("workspaceId is required outside an agent-scoped session");
  }

  const buildCallerAgentScheduleConfigExtras = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    resolvedProvider: string,
  ): Record<string, unknown> => {
    return {
      ...(callerAgent.config.thinkingOptionId
        ? { thinkingOptionId: callerAgent.config.thinkingOptionId }
        : {}),
      ...(callerAgent.provider === resolvedProvider && callerAgent.config.providerOptions
        ? { providerOptions: callerAgent.config.providerOptions }
        : {}),
      ...(callerAgent.config.featureValues
        ? { featureValues: callerAgent.config.featureValues }
        : {}),
      ...(callerAgent.config.systemPrompt ? { systemPrompt: callerAgent.config.systemPrompt } : {}),
      ...(callerAgent.config.mcpServers ? { mcpServers: callerAgent.config.mcpServers } : {}),
    };
  };

  const buildCallerAgentScheduleConfig = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    params?: { provider?: string; cwd?: string },
  ) => {
    const hasProviderOverride = params?.provider !== undefined;
    const resolvedProviderModel = hasProviderOverride
      ? resolveScheduleProviderAndModel({
          provider: params?.provider,
          defaultProvider: callerAgent.provider,
        })
      : null;
    const resolvedProvider = resolvedProviderModel?.provider ?? callerAgent.provider;
    let resolvedModel: string | undefined;
    if (resolvedProviderModel?.model) {
      resolvedModel = resolvedProviderModel.model;
    } else if (!hasProviderOverride && callerAgent.config.model) {
      resolvedModel = callerAgent.config.model;
    }
    return {
      provider: resolvedProvider,
      cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : callerAgent.cwd,
      ...(callerAgent.currentModeId && callerAgent.provider === resolvedProvider
        ? {
            modeId: callerAgent.currentModeId,
          }
        : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...buildCallerAgentScheduleConfigExtras(callerAgent, resolvedProvider),
    };
  };

  const resolveNewAgentScheduleTarget = (params?: {
    provider?: string;
    cwd?: string;
    isolation?: "local" | "worktree";
  }) => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return {
        type: "new-agent" as const,
        config: {
          ...buildCallerAgentScheduleConfig(callerAgent, params),
          ...(params?.isolation ? { isolation: params.isolation } : {}),
        },
      };
    }

    if (!params?.provider?.trim()) {
      throw new Error("provider is required when target is new-agent");
    }

    const resolvedProviderModel = resolveScheduleProviderAndModel({
      provider: params?.provider,
      defaultProvider: params.provider,
    });
    return {
      type: "new-agent" as const,
      config: {
        provider: resolvedProviderModel.provider,
        cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
        ...(params?.isolation ? { isolation: params.isolation } : {}),
      },
    };
  };

  async function requireScheduleTarget(id: string, type: "agent" | "new-agent") {
    if (!scheduleService) {
      throw new Error("Schedule service is not configured");
    }
    const schedule = await scheduleService.inspect(id);
    if (schedule.target.type !== type) {
      throw new Error(
        type === "agent" ? `Heartbeat not found: ${id}` : `Schedule not found: ${id}`,
      );
    }
    return schedule;
  }

  async function requireCallerHeartbeat(id: string) {
    if (!callerAgentId) {
      throw new Error("Heartbeat operations require an agent-scoped session");
    }
    const schedule = await requireScheduleTarget(id, "agent");
    if (schedule.target.type !== "agent" || schedule.target.agentId !== callerAgentId) {
      throw new Error(`Heartbeat ${id} does not belong to caller ${callerAgentId}`);
    }
    return schedule;
  }
  const ProviderModelInputSchema = AgentProviderEnum.trim()
    .refine((value) => value.includes("/"), {
      message: "provider must be provider/model, for example codex/gpt-5.4",
    })
    .refine(
      (value) => {
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider/model, for example codex/gpt-5.4" },
    );
  const ProviderOrProviderModelInputSchema = AgentProviderEnum.trim()
    .min(1, "provider is required")
    .refine(
      (value) => {
        if (!value.includes("/")) {
          return true;
        }
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider or provider/model, for example codex/gpt-5.4" },
    );
  const CreateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode to configure before the first run."),
      thinkingOptionId: z.string().optional().describe("Thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const UpdateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode ID."),
      model: z.string().nullable().optional().describe("Model ID. Pass null to clear."),
      thinkingOptionId: z
        .string()
        .nullable()
        .optional()
        .describe("Thinking option ID. Pass null to clear."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const InspectProviderSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Draft session mode ID."),
      model: z.string().optional().describe("Draft model ID."),
      thinkingOptionId: z.string().optional().describe("Draft thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Draft provider feature values."),
    })
    .strict();
  const AgentRelationshipInputSchema = z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("subagent") })
      .strict()
      .describe("Create a child agent under this agent's subagent track."),
    z
      .object({ kind: z.literal("detached") })
      .strict()
      .describe("Create a root agent that does not appear in this agent's subagent track."),
  ]);
  const AgentCreateWorktreeTargetInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("branch-off"),
        worktreeSlug: z
          .string()
          .min(1)
          .optional()
          .describe("Optional worktree slug/path label. Omit to let Paseo generate one."),
        branchName: z
          .string()
          .min(1)
          .optional()
          .describe("Optional git branch name. Defaults to the worktree slug."),
        baseBranch: z
          .string()
          .min(1)
          .optional()
          .describe("Optional base branch. Defaults to the repository default branch."),
      })
      .strict()
      .describe("Create a new branch in a new Paseo worktree."),
    z
      .object({
        kind: z.literal("checkout-branch"),
        branch: z.string().min(1).describe("Existing branch to check out."),
      })
      .strict()
      .describe("Check out an existing branch in a new Paseo worktree."),
    z
      .object({
        kind: z.literal("checkout-pr"),
        githubPrNumber: z.number().int().positive().describe("GitHub pull request number."),
      })
      .strict()
      .describe("Check out a GitHub pull request in a new Paseo worktree."),
  ]);
  const AgentWorkspaceInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("current"),
        cwd: z.string().optional().describe("Optional runtime cwd. Defaults to the caller's cwd."),
      })
      .strict()
      .describe("Use the caller's current workspace."),
    z
      .object({
        kind: z.literal("existing"),
        workspaceId: z.string().min(1).describe("Existing workspace id to attach the agent to."),
        cwd: z
          .string()
          .optional()
          .describe("Optional runtime cwd. Defaults to the existing workspace cwd."),
      })
      .strict()
      .describe("Attach the agent to an existing workspace."),
    z
      .object({
        kind: z.literal("create"),
        source: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("directory"),
              path: z
                .string()
                .optional()
                .describe("Optional directory path. Defaults to the caller's cwd."),
            })
            .strict(),
          z
            .object({
              kind: z.literal("worktree"),
              cwd: z
                .string()
                .optional()
                .describe("Optional source repository. Defaults to the caller's cwd."),
              target: AgentCreateWorktreeTargetInputSchema,
            })
            .strict(),
        ]),
      })
      .strict()
      .describe("Create a new workspace for the agent."),
  ]);
  const clientRequestIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Idempotency key: distinct per logical request, the same on every retry of it. A retry returns the original result instead of acting twice.",
    );
  const commonCreateAgentFields = {
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
    provider: ProviderModelInputSchema.describe(
      "Required provider/model pair, for example codex/gpt-5.4.",
    ),
    labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
    settings: CreateAgentSettingsInputSchema.optional().describe(
      "Initial runtime settings for the new agent.",
    ),
    initialPrompt: z
      .string()
      .trim()
      .min(1, "initialPrompt is required")
      .describe("Required first task to run immediately after creation."),
    clientRequestId: clientRequestIdSchema,
  };
  const legacyCreateAgentPlacementFields = {
    relationship: AgentRelationshipInputSchema.describe(
      "Whether the created agent is a subagent under you or a detached root agent.",
    ),
    workspace: AgentWorkspaceInputSchema.describe(
      "Workspace ownership/location for the created agent.",
    ),
  };
  const canonicalCreateAgentFields = {
    ...commonCreateAgentFields,
    workspaceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Existing workspace id. Agent-scoped calls default to the caller workspace; top-level calls create a new local workspace when omitted.",
      ),
  };
  const agentToAgentInputSchema = {
    ...canonicalCreateAgentFields,
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Get notified when the created agent finishes, errors, or needs permission. Set false only for truly fire-and-forget agents.",
      ),
  };
  const canonicalTopLevelInputSchema = {
    ...canonicalCreateAgentFields,
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the created agent finishes, errors, or needs permission.",
      ),
  };
  const legacyAgentToAgentInputSchema = {
    ...commonCreateAgentFields,
    ...legacyCreateAgentPlacementFields,
    notifyOnFinish: agentToAgentInputSchema.notifyOnFinish,
  };
  const legacyTopLevelCreateAgentInputSchema = {
    ...commonCreateAgentFields,
    relationship: legacyCreateAgentPlacementFields.relationship.optional(),
    workspace: legacyCreateAgentPlacementFields.workspace.optional(),
    background: canonicalTopLevelInputSchema.background,
    notifyOnFinish: canonicalTopLevelInputSchema.notifyOnFinish,
    cwd: z
      .string()
      .optional()
      .describe("Legacy top-level working directory. Prefer workspace.source.path."),
    mode: z.string().optional().describe("Legacy session mode ID. Prefer settings.modeId."),
    thinking: z
      .string()
      .optional()
      .describe("Legacy thinking option ID. Prefer settings.thinkingOptionId."),
    features: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Legacy feature values. Prefer settings.features."),
    worktreeName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy worktree slug. Prefer workspace.source.target.worktreeSlug."),
    branchName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy branch name. Prefer workspace.source.target.branchName."),
    baseBranch: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy base branch. Prefer workspace.source.target.baseBranch."),
    refName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy branch/ref to check out. Prefer workspace.source.target.branch."),
    githubPrNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Legacy GitHub PR number. Prefer workspace.source.target.githubPrNumber."),
  };
  const createAgentInputSchema = z
    .object(callerAgentId ? agentToAgentInputSchema : canonicalTopLevelInputSchema)
    .passthrough();
  const agentToAgentCreateAgentArgsSchema = z.object(agentToAgentInputSchema).strict();
  const legacyAgentToAgentCreateAgentArgsSchema = z.object(legacyAgentToAgentInputSchema).strict();
  const canonicalTopLevelCreateAgentArgsSchema = z.object(canonicalTopLevelInputSchema).strict();
  const legacyTopLevelCreateAgentArgsSchema = z
    .object(legacyTopLevelCreateAgentInputSchema)
    .strict();
  const commonSendAgentPromptInputSchema = {
    agentId: z.string(),
    prompt: z.string(),
    sessionMode: z.string().optional().describe("Optional mode to set before running the prompt."),
    delivery: z
      .enum(["auto", "queue", "steer", "restart"])
      .optional()
      .describe(
        callerAgentId
          ? "How to deliver to a busy agent. auto (default): steer into its running turn when the provider can, otherwise run after that turn. queue: run after the running turn. steer: steer into the running turn, failing if the provider cannot. restart: interrupt the running turn and start over with this prompt. An idle agent always starts right away."
          : "How to deliver to a busy agent. restart (default): interrupt the running turn and start over with this prompt. auto: steer when the provider can, otherwise run after the running turn. queue: run after the running turn. steer: steer, failing if the provider cannot.",
      ),
    clientRequestId: clientRequestIdSchema,
  };
  const agentToAgentSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    background: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Run agent in background. Agent-scoped default is true so you can continue until the finish notification arrives. Set false only when you need a blocking response.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Get notified when the prompted agent finishes, errors, or needs permission. Set false only for truly fire-and-forget prompts.",
      ),
  };
  const topLevelSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the prompted agent finishes, errors, or needs permission.",
      ),
  };
  const sendAgentPromptInputSchema = callerAgentId
    ? agentToAgentSendAgentPromptInputSchema
    : topLevelSendAgentPromptInputSchema;
  type SendAgentPromptArgs = Partial<
    z.infer<z.ZodObject<typeof agentToAgentSendAgentPromptInputSchema>>
  > &
    Pick<z.infer<z.ZodObject<typeof commonSendAgentPromptInputSchema>>, "agentId" | "prompt">;
  const inspectProviderInputSchema = {
    provider: ProviderOrProviderModelInputSchema.describe(
      "Provider ID, optionally with a model ID (for example codex or codex/gpt-5.4).",
    ),
    cwd: z
      .string()
      .optional()
      .describe("Working directory used to resolve provider feature availability."),
    settings: InspectProviderSettingsInputSchema.optional().describe(
      "Draft provider settings used to compute available features.",
    ),
  };
  type AgentToAgentCreateAgentArgs = z.infer<typeof agentToAgentCreateAgentArgsSchema>;
  type LegacyAgentToAgentCreateAgentArgs = z.infer<typeof legacyAgentToAgentCreateAgentArgsSchema>;
  type TopLevelCreateAgentArgs = z.infer<typeof canonicalTopLevelCreateAgentArgsSchema>;
  type LegacyTopLevelCreateAgentArgs = z.infer<typeof legacyTopLevelCreateAgentArgsSchema>;

  if (options.voiceOnly || options.enableVoiceTools || callerContext?.enableVoiceTools) {
    registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak text to the user via daemon-managed voice output. Blocks until playback completes.",
        inputSchema: {
          text: z
            .string()
            .trim()
            .min(1, "text is required")
            .max(4000, "text must be 4000 characters or fewer"),
        },
        outputSchema: {
          ok: z.boolean(),
        },
      },
      async (args, context) => {
        if (!callerAgentId) {
          throw new Error("speak is only available to agent-scoped tool sessions");
        }
        const handler = resolveSpeakHandler?.(callerAgentId) ?? null;
        if (!handler) {
          throw new Error(`No speak handler registered for your session '${callerAgentId}'`);
        }
        await handler({
          text: args.text,
          callerAgentId,
          signal: context?.signal,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({ ok: true }),
        };
      },
    );
  }

  if (options.voiceOnly) {
    return toCatalog();
  }

  if (options.browserToolsEnabled && options.browserToolsBroker) {
    registerBrowserTools({
      registerTool,
      broker: options.browserToolsBroker,
      callerAgentId,
      resolveCallerAgent,
    });
  }

  registerTool(
    "create_workspace",
    {
      title: "Create workspace",
      description:
        "Create a workspace using an existing local checkout or a new Paseo-managed worktree.",
      inputSchema: {
        isolation: z.enum(["local", "worktree"]),
        path: z
          .string()
          .optional()
          .describe(
            "Local directory or source checkout. Defaults to your current workspace. Local isolation adopts an existing directory and never creates one.",
          ),
        projectId: z.string().optional().describe("Existing project id to own the workspace."),
        title: z.string().trim().min(1).optional(),
        mode: z
          .enum(["branch-off", "checkout-branch", "checkout-pr"])
          .optional()
          .describe("Worktree creation mode. Defaults to branch-off."),
        worktreeSlug: z.string().trim().min(1).optional(),
        branchName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("New branch name for branch-off mode."),
        baseBranch: z.string().trim().min(1).optional().describe("Base ref for branch-off mode."),
        branch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Existing branch for checkout-branch mode."),
        prNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pull request or change request number for checkout-pr mode."),
        forge: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Forge for checkout-pr mode. Defaults to the source checkout."),
      },
      outputSchema: WorkspaceAutomationSummarySchema.shape,
    },
    async ({
      isolation,
      path,
      projectId,
      title,
      mode,
      worktreeSlug,
      branchName,
      baseBranch,
      branch,
      prNumber,
      forge,
    }) => {
      let workspace: PersistedWorkspaceRecord;
      if (isolation === "local") {
        const cwd = resolveScopedCwd(path, { required: true });
        if (!(await isExistingDirectory(cwd))) {
          throw new Error(`Directory not found: ${cwd}`);
        }
        assertOptionsAbsent(
          [
            ["mode", mode],
            ["worktreeSlug", worktreeSlug],
            ["branchName", branchName],
            ["baseBranch", baseBranch],
            ["branch", branch],
            ["prNumber", prNumber],
            ["forge", forge],
          ],
          "Worktree options require isolation worktree",
        );
        if (!options.createDirectoryWorkspace) {
          throw new Error("Workspace provisioning is not configured");
        }
        workspace = await options.createDirectoryWorkspace(cwd, title, projectId);
      } else {
        let cwd =
          path !== undefined || !projectId ? resolveScopedCwd(path, { required: true }) : null;
        if (!cwd) {
          if (!options.projectRegistry) {
            throw new Error("Project registry is not configured");
          }
          cwd = await resolveWorktreeSourceCwd({ projectId }, options.projectRegistry);
        }
        const worktreeTarget = resolveWorkspaceWorktreeTarget({
          mode,
          worktreeSlug,
          branchName,
          baseBranch,
          branch,
          prNumber,
          forge,
        });
        const result = await createPaseoWorktreeCommand(
          {
            paseoHome: options.paseoHome,
            worktreesRoot: options.worktreesRoot,
            createPaseoWorktreeWorkflow: options.createPaseoWorktree,
          },
          {
            cwd,
            ...(projectId ? { projectId } : {}),
            ...(worktreeSlug ? { worktreeSlug } : {}),
            ...worktreeTarget,
            ...(title ? { title } : {}),
          },
        );
        if (!result.ok) {
          throw result.cause;
        }
        workspace = result.createdWorktree.workspace;
      }

      return {
        content: [],
        structuredContent: ensureValidJson(toWorkspaceAutomationSummary(workspace)),
      };
    },
  );

  registerTool(
    "list_workspaces",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List workspaces",
      description: "List active workspaces.",
      inputSchema: {},
      outputSchema: { workspaces: z.array(WorkspaceAutomationSummarySchema) },
    },
    async () => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is not configured");
      }
      const workspaces = (await options.workspaceRegistry.list())
        .filter((workspace) => !workspace.archivedAt)
        .map(toWorkspaceAutomationSummary);
      return {
        content: [],
        structuredContent: ensureValidJson({ workspaces }),
      };
    },
  );

  registerTool(
    "archive_workspace",
    {
      title: "Archive workspace",
      description: "Archive a workspace and everything it owns.",
      inputSchema: { workspaceId: z.string().min(1) },
      outputSchema: {
        workspaceId: z.string(),
        archivedAgentIds: z.array(z.string()),
        removedDirectory: z.boolean(),
      },
    },
    async ({ workspaceId }) => {
      if (!options.listActiveWorkspaces) {
        throw new Error("Active workspace lister is required to archive workspaces");
      }
      const workspace = await requireActiveWorkspaceForArchive(
        { listActiveWorkspaces: options.listActiveWorkspaces },
        workspaceId,
      );
      const result = await archiveByScope(
        archiveWorktreeDependencies(options, {
          agentManager,
          agentStorage,
          terminalManager: terminalManager ?? null,
          logger: childLogger,
        }),
        {
          requestId: "mcp:archive_workspace",
          scope: { kind: "workspace", workspaceId: workspace.workspaceId },
        },
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          workspaceId,
          archivedAgentIds: result.archivedAgentIds,
          removedDirectory: result.removedDirectory,
        }),
      };
    },
  );

  const VOICE_ANNOUNCES_RESULT_GUIDANCE =
    "Paseo tells the user the agent's result when it finishes. Do not wait or poll; say you'll let them know.";

  // A caller that hears results through its own channel (the voice call) must not also get a
  // finish notification steered into its turn, where a newer request can cut it off.
  function callerHearsResultsItself(): boolean {
    return Boolean(callerContext?.onAgentPrompted);
  }

  function resolveCreateMode(requested: string | undefined, provider: string): string | undefined {
    if (requested !== undefined || !callerContext?.actsForUser) return requested;
    return callerContext.defaultModeFor?.(provider);
  }

  function createdAgentGuidance(notifyOnFinish: boolean): string | undefined {
    if (callerHearsResultsItself()) return VOICE_ANNOUNCES_RESULT_GUIDANCE;
    if (callerAgentId && notifyOnFinish) {
      return "You will get notified when the created agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.";
    }
    return undefined;
  }

  registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create an agent. Agent-scoped creation defaults to your workspace and creates your subagent. Top-level creation without workspaceId creates a new local workspace. Requires provider/model (for example codex/gpt-5.4) and an initial prompt. Do not guess; call list_providers and list_models first if uncertain.",
      inputSchema: createAgentInputSchema,
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        workspaceId: z.string().optional(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(ProviderModeSchema),
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        guidance: z.string().optional(),
        deduplicated: z.boolean().optional(),
      },
    },
    async (args: unknown) => {
      const clientRequestId = clientRequestIdSchema.parse(
        (args as { clientRequestId?: unknown }).clientRequestId,
      );
      if (!clientRequestId) {
        return await createAgentFromTool(args, undefined);
      }
      const creation = { callerAgentId: callerAgentId ?? null, clientRequestId };
      return await serializeCreateRequest(agentStorage, creation, async () => {
        const existing = await agentStorage.findByCreationRequest(creation);
        if (existing) {
          return deduplicatedCreateResponse(existing);
        }
        return await createAgentFromTool(args, clientRequestId);
      });
    },
  );

  function deduplicatedCreateResponse(record: StoredAgentRecord) {
    const live = agentManager.getAgent(record.id);
    const workspaceId = live?.workspaceId ?? record.workspaceId;
    return {
      content: [],
      structuredContent: ensureValidJson({
        agentId: record.id,
        type: record.provider,
        status: live?.lifecycle ?? record.lastStatus,
        cwd: live?.cwd ?? record.cwd,
        ...(workspaceId ? { workspaceId } : {}),
        currentModeId: live?.currentModeId ?? record.lastModeId ?? null,
        availableModes: live?.availableModes ?? [],
        lastMessage: null,
        permission: null,
        deduplicated: true,
      }),
    };
  }

  async function createAgentFromTool(args: unknown, clientRequestId: string | undefined) {
    const resolvedArgs = await resolveCreateAgentToolArgs(args);
    const { parsedArgs, worktree } = resolvedArgs;
    let requestedBackground: boolean;
    let notifyOnFinish: boolean;
    if (resolvedArgs.kind === "agent-scoped") {
      requestedBackground = true;
      notifyOnFinish = parsedArgs.notifyOnFinish;
    } else {
      requestedBackground = resolvedArgs.parsedArgs.background;
      notifyOnFinish = resolvedArgs.parsedArgs.notifyOnFinish ?? false;
    }
    notifyOnFinish &&= !callerHearsResultsItself();
    const selectedProvider = resolveRequiredProviderModel(parsedArgs.provider).provider;
    const inheritedConfig = resolveInheritedProviderConfig(selectedProvider);
    const mode = resolveCreateMode(parsedArgs.settings?.modeId, selectedProvider);
    const {
      snapshot,
      background: createdInBackground,
      initialPromptStarted,
    } = await createAgentCommand(
      {
        agentManager,
        agentStorage,
        logger: childLogger,
        paseoHome: options.paseoHome,
        worktreesRoot: options.worktreesRoot,
        terminalManager,
        providerSnapshotManager,
        createPaseoWorktree: options.createPaseoWorktree,
        ...(options.ensureWorkspaceForCreate
          ? { ensureWorkspaceForCreate: options.ensureWorkspaceForCreate }
          : {}),
        delegations: options.delegations,
      },
      {
        kind: "mcp",
        provider: parsedArgs.provider,
        title: parsedArgs.title,
        initialPrompt: parsedArgs.initialPrompt,
        config: inheritedConfig,
        cwd: resolvedArgs.cwd,
        workspaceId: resolvedArgs.workspaceId,
        thinking: parsedArgs.settings?.thinkingOptionId,
        features: parsedArgs.settings?.features,
        labels: parsedArgs.labels,
        mode,
        background: requestedBackground,
        notifyOnFinish,
        detached: resolvedArgs.detached,
        callerAgentId,
        clientRequestId,
        callerContext,
        worktree,
      },
    );
    if (initialPromptStarted) callerContext?.onAgentPrompted?.(snapshot.id);

    try {
      if (!createdInBackground && initialPromptStarted) {
        const result = await waitForAgentWithTimeout(agentManager, snapshot.id, {
          waitForActive: true,
        });

        const liveSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
        const responseData = {
          agentId: snapshot.id,
          type: snapshot.provider,
          status: result.status,
          cwd: liveSnapshot.cwd,
          ...(liveSnapshot.workspaceId ? { workspaceId: liveSnapshot.workspaceId } : {}),
          currentModeId: liveSnapshot.currentModeId,
          availableModes: liveSnapshot.availableModes,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
        };
        const validJson = ensureValidJson(responseData);

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
      }
    } catch (error) {
      childLogger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
      throw error;
    }

    // Return immediately for async creation.
    const currentSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
    const guidance = initialPromptStarted ? createdAgentGuidance(notifyOnFinish) : undefined;
    const response = {
      content: [],
      structuredContent: ensureValidJson({
        agentId: currentSnapshot.id,
        type: snapshot.provider,
        status: currentSnapshot.lifecycle,
        cwd: currentSnapshot.cwd,
        ...(currentSnapshot.workspaceId ? { workspaceId: currentSnapshot.workspaceId } : {}),
        currentModeId: currentSnapshot.currentModeId,
        availableModes: currentSnapshot.availableModes,
        lastMessage: null,
        permission: null,
        ...(guidance ? { guidance } : {}),
      }),
    };
    return response;
  }

  type ResolvedCreateAgentToolArgs =
    | {
        kind: "agent-scoped";
        parsedArgs: AgentToAgentCreateAgentArgs | LegacyAgentToAgentCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
        worktree: CreateAgentFromMcpInput["worktree"];
      }
    | {
        kind: "top-level";
        parsedArgs: TopLevelCreateAgentArgs | LegacyTopLevelCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
        worktree: CreateAgentFromMcpInput["worktree"];
      };

  async function resolveCreateAgentToolArgs(args: unknown): Promise<ResolvedCreateAgentToolArgs> {
    if (callerAgentId) {
      if (hasLegacyCreateAgentPlacement(args)) {
        // COMPAT(nestedCreateAgentPlacement): accept the old relationship/workspace shape without
        // advertising it to models. Added in v0.2.0; remove after 2027-01-17.
        const parsed = legacyAgentToAgentCreateAgentArgsSchema.parse(args);
        const { cwd, workspaceId, worktree } = await resolveCreateAgentWorkspace(parsed.workspace, {
          prompt: parsed.initialPrompt,
        });
        return {
          kind: "agent-scoped",
          parsedArgs: parsed,
          detached: parsed.relationship.kind === "detached",
          cwd,
          workspaceId,
          worktree,
        };
      }
      const parsed = agentToAgentCreateAgentArgsSchema.parse(args);
      if (callerContext?.actsForUser && !parsed.workspaceId) {
        throw new Error(
          "Pass workspaceId: the workspace the user means (see list_workspaces, or create_workspace first). You have no workspace of your own to default to.",
        );
      }
      const { cwd, workspaceId } = await resolveCanonicalCreateAgentWorkspace(parsed.workspaceId, {
        prompt: parsed.initialPrompt,
      });
      return {
        kind: "agent-scoped",
        parsedArgs: parsed,
        // A subagent of a hidden caller would never show up in the user's agent list.
        detached: callerContext?.actsForUser ?? false,
        cwd,
        workspaceId,
        worktree: undefined,
      };
    }
    if (hasLegacyCreateAgentPlacement(args)) {
      // COMPAT(nestedCreateAgentPlacement): see the agent-scoped branch above.
      const parsedArgs = normalizeTopLevelCreateAgentArgs(
        legacyTopLevelCreateAgentArgsSchema.parse(args),
      );
      if (parsedArgs.relationship?.kind === "subagent") {
        throw new Error("relationship subagent requires an agent-scoped tool session");
      }
      if (!parsedArgs.workspace) {
        throw new Error("Legacy create_agent placement could not be resolved");
      }
      const { cwd, workspaceId, worktree } = await resolveCreateAgentWorkspace(
        parsedArgs.workspace,
        { prompt: parsedArgs.initialPrompt },
      );
      return {
        kind: "top-level",
        parsedArgs,
        detached: true,
        cwd,
        workspaceId,
        worktree,
      };
    }
    const parsedArgs = canonicalTopLevelCreateAgentArgsSchema.parse(args);
    const { cwd, workspaceId } = await resolveCanonicalCreateAgentWorkspace(
      parsedArgs.workspaceId,
      { prompt: parsedArgs.initialPrompt },
    );
    return {
      kind: "top-level",
      parsedArgs,
      detached: false,
      cwd,
      workspaceId,
      worktree: undefined,
    };
  }

  function hasLegacyCreateAgentPlacement(args: unknown): boolean {
    if (!args || typeof args !== "object") {
      return false;
    }
    const input = args as Record<string, unknown>;
    return [
      "relationship",
      "workspace",
      "cwd",
      "worktreeName",
      "branchName",
      "baseBranch",
      "refName",
      "githubPrNumber",
    ].some((key) => input[key] !== undefined);
  }

  async function resolveCanonicalCreateAgentWorkspace(
    workspaceId?: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string;
  }> {
    if (workspaceId) {
      const resolved = await resolveCreateAgentWorkspace(
        { kind: "existing", workspaceId },
        undefined,
      );
      return { cwd: resolved.cwd, workspaceId };
    }
    if (!callerAgentId) {
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      const cwd = process.cwd();
      return {
        cwd,
        workspaceId: await options.ensureWorkspaceForCreate(cwd, firstAgentContext),
      };
    }
    const caller = resolveCallerAgent();
    if (!caller?.workspaceId) {
      throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
    }
    return { cwd: undefined, workspaceId: caller.workspaceId };
  }

  function normalizeTopLevelCreateAgentArgs(
    args: LegacyTopLevelCreateAgentArgs,
  ): LegacyTopLevelCreateAgentArgs {
    const {
      cwd,
      mode,
      thinking,
      features,
      worktreeName,
      branchName,
      baseBranch,
      refName,
      githubPrNumber,
      ...canonicalCandidate
    } = args;
    const settings = {
      ...canonicalCandidate.settings,
      ...(mode ? { modeId: mode } : {}),
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      ...(features ? { features } : {}),
    };

    if (canonicalCandidate.relationship && canonicalCandidate.workspace) {
      return legacyTopLevelCreateAgentArgsSchema.parse({
        ...canonicalCandidate,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      });
    }

    if (canonicalCandidate.relationship || canonicalCandidate.workspace) {
      throw new Error("relationship and workspace must be provided together");
    }

    if (!cwd?.trim()) {
      throw new Error("cwd is required for legacy top-level create_agent calls");
    }

    const legacyWorktreeTarget = resolveLegacyCreateAgentWorktreeTarget({
      worktreeName,
      branchName,
      baseBranch,
      refName,
      githubPrNumber,
    });
    const workspace = legacyWorktreeTarget
      ? {
          kind: "create" as const,
          source: {
            kind: "worktree" as const,
            cwd,
            target: legacyWorktreeTarget,
          },
        }
      : {
          kind: "create" as const,
          source: {
            kind: "directory" as const,
            path: cwd,
          },
        };

    return legacyTopLevelCreateAgentArgsSchema.parse({
      ...canonicalCandidate,
      relationship: { kind: "detached" },
      workspace,
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    });
  }

  function resolveLegacyCreateAgentWorktreeTarget(input: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    githubPrNumber?: number;
  }): z.infer<typeof AgentCreateWorktreeTargetInputSchema> | null {
    if (input.githubPrNumber !== undefined) {
      return {
        kind: "checkout-pr",
        githubPrNumber: input.githubPrNumber,
      };
    }

    if (input.refName) {
      return {
        kind: "checkout-branch",
        branch: input.refName,
      };
    }

    if (input.worktreeName || input.branchName || input.baseBranch) {
      return {
        kind: "branch-off",
        worktreeSlug: input.worktreeName,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
      };
    }

    return null;
  }

  async function resolveCreateAgentWorkspace(
    workspace:
      | LegacyAgentToAgentCreateAgentArgs["workspace"]
      | NonNullable<LegacyTopLevelCreateAgentArgs["workspace"]>,
    firstAgentContext: FirstAgentContext | undefined,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string | undefined;
    worktree: CreateAgentFromMcpInput["worktree"];
  }> {
    if (workspace.kind === "current") {
      if (!callerAgentId) {
        throw new Error("workspace current requires an agent-scoped tool session");
      }
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
      }
      return {
        cwd: workspace.cwd,
        workspaceId: callerAgent.workspaceId,
        worktree: undefined,
      };
    }

    if (workspace.kind === "existing") {
      if (!options.listActiveWorkspaces) {
        throw new Error("Workspace lookup is not configured");
      }
      const existingWorkspace = (await options.listActiveWorkspaces()).find(
        (candidate) => candidate.workspaceId === workspace.workspaceId,
      );
      if (!existingWorkspace) {
        throw new Error(`Workspace ${workspace.workspaceId} not found`);
      }
      const cwd = workspace.cwd
        ? resolveScopedCwd(workspace.cwd, { required: true })
        : existingWorkspace.cwd;
      const lockedCwd = callerContext?.lockedCwd?.trim();
      if (lockedCwd && !isSameOrDescendantPath(expandUserPath(lockedCwd), cwd)) {
        throw new Error(`Workspace ${workspace.workspaceId} is outside the allowed cwd`);
      }
      return {
        cwd,
        workspaceId: workspace.workspaceId,
        worktree: undefined,
      };
    }

    if (workspace.source.kind === "directory") {
      const cwd = resolveScopedCwd(workspace.source.path, { required: true });
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      return {
        cwd,
        workspaceId: await options.ensureWorkspaceForCreate(cwd, firstAgentContext),
        worktree: undefined,
      };
    }

    const cwd = resolveScopedCwd(workspace.source.cwd, { required: true });
    return {
      cwd,
      workspaceId: undefined,
      worktree: resolveCreateAgentWorktree(workspace.source.target),
    };
  }

  function resolveCreateAgentWorktree(
    target: z.infer<typeof AgentCreateWorktreeTargetInputSchema>,
  ): NonNullable<CreateAgentFromMcpInput["worktree"]> {
    switch (target.kind) {
      case "branch-off":
        return {
          action: "branch-off",
          worktreeName: target.worktreeSlug,
          branchName: target.branchName,
          baseBranch: target.baseBranch,
        };
      case "checkout-branch":
        return {
          action: "checkout",
          refName: target.branch,
        };
      case "checkout-pr":
        return {
          action: "checkout",
          githubPrNumber: target.githubPrNumber,
        };
      default:
        throw new Error("unreachable");
    }
  }

  const PROMPTED_AGENT_NOTIFICATION_GUIDANCE =
    "You will get notified when the prompted agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.";

  registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description: callerAgentId
        ? "Send a task to an agent. Runs in background by default. A busy agent gets the prompt steered into its running turn, or after that turn ends; it is never interrupted unless delivery is restart."
        : "Send a task to an agent. Waits for the result by default. A busy agent is interrupted unless you pass another delivery.",
      inputSchema: sendAgentPromptInputSchema,
      outputSchema: {
        success: z.boolean(),
        status: AgentStatusEnum,
        disposition: z
          .enum(["started", "steered", "queued", "restarted", "out_of_band", "duplicate"])
          .optional(),
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        guidance: z.string().optional(),
      },
    },
    async (args: SendAgentPromptArgs) => {
      const { agentId, prompt } = args;
      const background = args.background ?? Boolean(callerAgentId);
      const notifyOnFinish = args.notifyOnFinish ?? Boolean(callerAgentId);

      async function laterResultGuidance(
        disposition: SendDisposition,
      ): Promise<string | undefined> {
        if (callerHearsResultsItself()) return VOICE_ANNOUNCES_RESULT_GUIDANCE;
        if (disposition === "out_of_band" || !callerAgentId || !notifyOnFinish) return undefined;
        await options.delegations?.delegate({
          parentAgentId: callerAgentId,
          childAgentId: agentId,
          source: "send_agent_prompt",
          title: (await agentStorage.get(agentId))?.title ?? agentId,
          prompt,
          requireParentOwnership: false,
        });
        return PROMPTED_AGENT_NOTIFICATION_GUIDANCE;
      }

      await prepareAgentForPrompt({
        agentManager,
        agentStorage,
        agentId,
        sessionMode: args.sessionMode,
        logger: childLogger,
      });
      const messageId = args.clientRequestId
        ? deriveClientMessageId(callerAgentId, args.clientRequestId)
        : `mcp:${randomUUID()}`;
      if (args.clientRequestId && isMessageAlreadyDispatched(agentManager, agentId, messageId)) {
        return sendPromptResponse({ status: currentStatus(agentId), disposition: "duplicate" });
      }

      const dispatch = await dispatchPrompt({
        agentId,
        prompt,
        messageId,
        delivery: args.delivery ?? (callerAgentId ? "auto" : "restart"),
      });
      const disposition = toSendDisposition(dispatch.disposition);
      callerContext?.onAgentPrompted?.(agentId);

      if (!background) {
        const result = await waitForSentPrompt(agentId, dispatch);
        // The wait ran out while the agent keeps working, so its result arrives later
        // instead of in this response.
        const guidance = result.stillWorking ? await laterResultGuidance(disposition) : undefined;
        return sendPromptResponse({ ...result, disposition, guidance });
      }

      // Awaiting the delegation first would let a fast turn end before the start wait begins.
      const delegated = laterResultGuidance(disposition);
      let guidance: string | undefined;
      try {
        // Return once the provider has accepted the turn, so the status reports it running.
        // A turn that already ended has no start left to wait for.
        const startedTurn = disposition === "started" || disposition === "restarted";
        if (startedTurn && agentManager.hasInFlightRun(agentId)) {
          await waitForAgentRunStartWithTimeout(agentManager, agentId);
        }
      } finally {
        guidance = await delegated;
      }
      return sendPromptResponse({ status: currentStatus(agentId), disposition, guidance });
    },
  );

  function currentStatus(agentId: string): z.infer<typeof AgentStatusEnum> {
    return agentManager.getAgent(agentId)?.lifecycle ?? "idle";
  }

  function sendPromptResponse(data: {
    status: z.infer<typeof AgentStatusEnum>;
    disposition: SendDisposition;
    lastMessage?: string | null;
    permission?: AgentPermissionRequest | null;
    guidance?: string;
  }) {
    return {
      content: [],
      structuredContent: ensureValidJson({
        success: true,
        status: data.status,
        disposition: data.disposition,
        lastMessage: data.lastMessage ?? null,
        permission: sanitizePermissionRequest(data.permission),
        ...(data.guidance ? { guidance: data.guidance } : {}),
      }),
    };
  }

  /** A queued prompt keeps dispatching after this returns; its failure can only be logged. */
  async function dispatchPrompt(input: {
    agentId: string;
    prompt: string;
    messageId: string;
    delivery: DispatchIntent;
  }): Promise<BackgroundDispatch> {
    let dispatch: BackgroundDispatch;
    try {
      dispatch = await dispatchAgentMessageInBackground({
        agentManager,
        agentStorage,
        agentId: input.agentId,
        messageId: input.messageId,
        policy: {
          intent: input.delivery,
          prompt: input.prompt,
          steerUnavailable: "fail",
          ...(callerAgentId ? { origin: { kind: "agent" as const, agentId: callerAgentId } } : {}),
        },
        logger: childLogger,
      });
    } catch (error) {
      if (error instanceof SteerUnavailableError) {
        throw new Error(
          `Agent ${input.agentId} is running and its provider cannot take a steer. Use delivery auto or queue to run after its turn, or restart to interrupt it.`,
          { cause: error },
        );
      }
      throw error;
    }
    void dispatch.settled
      .catch((error: unknown) => {
        childLogger.error(
          { err: error, agentId: input.agentId, messageId: input.messageId },
          "Queued agent prompt failed",
        );
      })
      .finally(() => options.delegations?.refreshChild(input.agentId));
    return dispatch;
  }

  async function waitForSentPrompt(agentId: string, dispatch: BackgroundDispatch) {
    const started =
      dispatch.disposition !== "queued" ||
      (await settlesWithin(dispatch.settled, AGENT_WAIT_TIMEOUT_MS));
    if (!started) {
      return {
        status: currentStatus(agentId),
        lastMessage: `The prompt is queued behind the agent's running turn and did not start within ${Math.round(AGENT_WAIT_TIMEOUT_MS / 1000)}s.`,
        permission: null,
        stillWorking: true,
      };
    }
    const result = await waitForAgentWithTimeout(agentManager, agentId, { waitForActive: true });
    return {
      status: result.status,
      lastMessage: result.lastMessage,
      permission: result.permission,
      stillWorking: result.timedOut && agentManager.getAgent(agentId)?.lifecycle === "running",
    };
  }

  // Reading a delegated child's terminal result acknowledges it, which cancels a wake for that
  // result that has not started yet.
  async function readDelegatedResult(
    childAgentId: string,
  ): Promise<z.infer<typeof DelegatedTaskResultSchema> | null> {
    if (!callerAgentId || !options.delegations) return null;
    const task = await options.delegations.acknowledgeChildResults({
      parentAgentId: callerAgentId,
      childAgentId,
    });
    if (!task || task.status === "running") return null;
    return {
      taskId: task.id,
      status: task.status,
      result: task.result,
      resultTruncated: task.resultTruncated,
    };
  }

  registerTool(
    "get_agent_status",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "Get agent status",
      description:
        "Return the latest snapshot for an agent, including lifecycle state, capabilities, and pending permissions. For your own delegated agent that finished, also returns its result.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        status: AgentStatusEnum,
        snapshot: AgentSnapshotPayloadSchema,
        delegatedTask: DelegatedTaskResultSchema.optional(),
      },
    },
    async ({ agentId }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (snapshot) {
        const structuredSnapshot = await serializeSnapshotWithMetadata(
          agentStorage,
          snapshot,
          childLogger,
        );
        const delegatedTask = await readDelegatedResult(agentId);
        return {
          content: [],
          structuredContent: ensureValidJson({
            status: snapshot.lifecycle,
            snapshot: structuredSnapshot,
            ...(delegatedTask ? { delegatedTask } : {}),
          }),
        };
      }

      const record = await agentStorage.get(agentId);
      if (!record || record.internal) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const structuredSnapshot = buildStoredAgentPayload(
        record,
        new Set(providerSnapshotManager.listRegisteredProviderIds()),
      );
      const delegatedTask = await readDelegatedResult(agentId);
      return {
        content: [],
        structuredContent: ensureValidJson({
          status: structuredSnapshot.status,
          snapshot: structuredSnapshot,
          ...(delegatedTask ? { delegatedTask } : {}),
        }),
      };
    },
  );

  function resolveBaseProvider(provider: string): string {
    let current = provider;
    for (let depth = 0; depth < 8; depth += 1) {
      const next = providerSnapshotManager.getProviderExtends(current);
      if (!next) return current;
      current = next;
    }
    return current;
  }

  /** The longest wait the caller's MCP client lets one tool call run. */
  function resolveMaxWaitMs(): number {
    if (options.transport === "native") return MAX_AGENT_WAIT_MS;
    const caller = callerAgentId ? agentManager.getAgent(callerAgentId) : null;
    if (caller && RAISED_TOOL_TIMEOUT_PROVIDERS.has(resolveBaseProvider(caller.provider))) {
      return MAX_AGENT_WAIT_MS;
    }
    return UNVERIFIED_CLIENT_MAX_WAIT_MS;
  }

  registerTool(
    "wait_for_agent",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "Wait for agent",
      description:
        "Block until an agent is idle, errored, or needs permission, or the wait times out. Returns at once for an agent that is not working. Timing out does not stop the agent; your delegated agent then notifies you when it finishes. Reading a finished delegated result here means you will not also be notified of it.",
      inputSchema: {
        agentId: z.string(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Wait budget in ms. Default 600000, clamped to limits.maxWaitMs from get_orchestration_capabilities.",
          ),
      },
      outputSchema: {
        agentId: z.string(),
        status: AgentStatusEnum,
        timedOut: z.boolean(),
        lastMessage: z.string().nullable(),
        permission: AgentPermissionRequestPayloadSchema.nullable(),
        delegatedTask: DelegatedTaskResultSchema.optional(),
        guidance: z.string().optional(),
      },
    },
    async ({ agentId, timeoutMs }, context) => {
      const budgetMs = Math.min(
        resolveMaxWaitMs(),
        Math.max(1, timeoutMs ?? DEFAULT_AGENT_WAIT_MS),
      );
      if (!agentManager.getAgent(agentId)) {
        const record = await agentStorage.get(agentId);
        if (!record || record.internal) {
          throw new Error(`Agent ${agentId} not found`);
        }
        return waitResponse(agentId, {
          status: record.lastStatus,
          timedOut: false,
          lastMessage: null,
          permission: null,
          delegatedTask: await readDelegatedResult(agentId),
        });
      }
      const outcome = await waitForAgentOutcome(agentId, budgetMs, context.signal);
      const status = agentManager.getAgent(agentId)?.lifecycle ?? outcome.status;
      if (outcome.timedOut) {
        return waitResponse(agentId, {
          status,
          timedOut: true,
          lastMessage: null,
          permission: null,
          guidance: `Waited ${Math.round(budgetMs / 1000)}s and the agent is still working; it was not stopped. Continue with other work: you will be notified when your delegated agent finishes, or call wait_for_agent again.`,
        });
      }
      return waitResponse(agentId, {
        status,
        timedOut: false,
        lastMessage: outcome.lastMessage,
        permission: outcome.permission,
        delegatedTask: outcome.permission ? null : await readDelegatedResult(agentId),
      });
    },
  );

  /**
   * Waits for the agent, then for the caller's delegated task on it to settle. The caller's
   * wake for that task is held for the wait and released unless the wait read the result.
   */
  async function waitForAgentOutcome(
    agentId: string,
    budgetMs: number,
    requestSignal: AbortSignal | undefined,
  ): Promise<{
    status: z.infer<typeof AgentStatusEnum>;
    timedOut: boolean;
    lastMessage: string | null;
    permission: AgentPermissionRequest | null;
  }> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("wait timeout")), budgetMs);
    const signal = requestSignal
      ? AbortSignal.any([deadline.signal, requestSignal])
      : deadline.signal;
    const delegation =
      callerAgentId && options.delegations
        ? { delegations: options.delegations, parentAgentId: callerAgentId, childAgentId: agentId }
        : null;
    let readsResult = false;
    try {
      await delegation?.delegations.beginWait(delegation);
      const result = await agentManager.waitForAgentEvent(agentId, { signal });
      if (!result.permission && delegation) {
        await delegation.delegations.waitForChildResult({ ...delegation, signal });
      }
      readsResult = !result.permission;
      return { ...result, timedOut: false };
    } catch (error) {
      if (!deadline.signal.aborted) throw error;
      return { status: "running", timedOut: true, lastMessage: null, permission: null };
    } finally {
      clearTimeout(timer);
      if (delegation && !readsResult) {
        await delegation.delegations.endWait(delegation);
      }
    }
  }

  function waitResponse(
    agentId: string,
    data: {
      status: z.infer<typeof AgentStatusEnum>;
      timedOut: boolean;
      lastMessage: string | null;
      permission: AgentPermissionRequest | null;
      delegatedTask?: z.infer<typeof DelegatedTaskResultSchema> | null;
      guidance?: string;
    },
  ) {
    return {
      content: [],
      structuredContent: ensureValidJson({
        agentId,
        status: data.status,
        timedOut: data.timedOut,
        lastMessage: data.lastMessage,
        permission: sanitizePermissionRequest(data.permission),
        ...(data.delegatedTask ? { delegatedTask: data.delegatedTask } : {}),
        ...(data.guidance ? { guidance: data.guidance } : {}),
      }),
    };
  }

  const pullRequestWatches = options.pullRequestWatches;
  if (pullRequestWatches) {
    const pullRequestTargetSchema = {
      number: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Pull request number in your workspace's repository."),
      url: z.string().optional().describe("Pull request URL, instead of number."),
    };
    async function resolveCallerTarget(input: { number?: number; url?: string }) {
      if (!callerAgentId) {
        throw new Error("Only an agent can watch a pull request");
      }
      const cwd =
        agentManager.getAgent(callerAgentId)?.cwd ?? (await agentStorage.get(callerAgentId))?.cwd;
      if (!cwd) {
        throw new Error(`Agent ${callerAgentId} not found`);
      }
      return { agentId: callerAgentId, cwd, number: input.number, url: input.url };
    }

    registerTool(
      "watch_pull_request",
      {
        title: "Watch pull request",
        description:
          "Have Paseo watch an open pull request for you. Omit number and url to watch the pull request of your workspace's branch. Paseo checks it every minute and wakes you with a message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict with its base. Use this to babysit a pull request instead of polling, sleeping, or running a watcher. The result reports the checks as they are now and only later changes wake you, so handle current failures and comments first, then end your turn. A wake is news, not a merge decision. Watching ends when the pull request merges or closes, when Paseo cannot read it for 15 minutes, when you are archived, or when you call unwatch_pull_request.",
        inputSchema: pullRequestTargetSchema,
        outputSchema: {
          number: z.number(),
          url: z.string(),
          title: z.string(),
          watching: z.literal(true),
          wasWatching: z.boolean(),
          checks: z.object({
            failed: z.array(z.string()),
            pending: z.number(),
            passed: z.boolean(),
          }),
          conflicting: z.boolean(),
        },
      },
      async (input: { number?: number; url?: string }) => ({
        content: [],
        structuredContent: ensureValidJson(
          await pullRequestWatches.watch(await resolveCallerTarget(input)),
        ),
      }),
    );

    registerTool(
      "unwatch_pull_request",
      {
        title: "Stop watching pull request",
        description:
          "Stop Paseo from watching a pull request for you. Omit number and url for the pull request of your workspace's branch. Unwatching one you don't watch succeeds with wasWatching false.",
        inputSchema: pullRequestTargetSchema,
        outputSchema: {
          number: z.number(),
          url: z.string().nullable(),
          watching: z.literal(false),
          wasWatching: z.boolean(),
        },
      },
      async (input: { number?: number; url?: string }) => ({
        content: [],
        structuredContent: ensureValidJson(
          await pullRequestWatches.unwatch(await resolveCallerTarget(input)),
        ),
      }),
    );
  }

  registerTool(
    "list_agents",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List agents",
      description:
        "List recent agents as compact metadata. By default, agents under your working directory; scope widens or narrows that.",
      inputSchema: {
        includeArchived: z.boolean().optional().default(false),
        cwd: z.string().optional(),
        sinceHours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .default(48),
        statuses: z.array(AgentStatusEnum).optional(),
        limit: z.number().int().positive().max(200).optional().default(50),
        scope: z
          .enum(["cwd", "children", "workspace", "project", "all"])
          .optional()
          .describe(
            "cwd (default): under your working directory. children: your subagents, in any workspace. workspace: in your workspace. project: in any workspace of your project. all: every agent.",
          ),
        parentAgentId: z
          .string()
          .optional()
          .describe("Only subagents of this agent, in any workspace unless scope says otherwise."),
        titleContains: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .optional()
          .describe("Case-insensitive title filter."),
      },
      outputSchema: {
        agents: z.array(AgentListItemPayloadSchema),
      },
    },
    async (args: ListAgentsArgs) => {
      const { includeArchived = false, sinceHours = 48, statuses, limit = 50 } = args;
      const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;
      const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
      const inScope = await resolveAgentListScope(args);
      const titleNeedle = args.titleContains?.toLowerCase();
      const liveSnapshots = agentManager.listAgents();
      const liveAgents = await Promise.all(
        liveSnapshots.map((snapshot) =>
          serializeSnapshotWithMetadata(agentStorage, snapshot, childLogger),
        ),
      );
      const liveIds = new Set(liveSnapshots.map((snapshot) => snapshot.id));
      const storedRecords = await agentStorage.list();
      const registeredProviderIds = new Set(providerSnapshotManager.listRegisteredProviderIds());
      const storedAgents = storedRecords
        .filter((record) => !record.internal && !liveIds.has(record.id))
        .filter((record) => includeArchived || !record.archivedAt)
        .filter(
          (record) =>
            includeArchived || isStoredAgentProviderAvailable(record, registeredProviderIds),
        )
        .map((record) => buildStoredAgentPayload(record, registeredProviderIds));
      const agents = [...liveAgents, ...storedAgents]
        .filter(inScope)
        .map(toAgentListItemPayload)
        .filter((agent) => !titleNeedle || agent.title?.toLowerCase().includes(titleNeedle))
        .filter((agent) => !statusFilter || statusFilter.has(agent.status))
        .filter((agent) => !agent.archivedAt || resolveAgentListActivityTime(agent) >= sinceMs)
        .sort(compareAgentListItems)
        .slice(0, limit);

      return {
        content: [],
        structuredContent: ensureValidJson({ agents }),
      };
    },
  );

  async function resolveAgentListScope(
    args: ListAgentsArgs,
  ): Promise<(agent: AgentSnapshotPayload) => boolean> {
    const caller = callerAgentId ? resolveCallerAgent() : null;
    const scope = args.scope ?? (args.parentAgentId ? "all" : "cwd");
    const explicitCwd = args.cwd?.trim() ? expandUserPath(args.cwd) : undefined;
    const cwdFilter = explicitCwd ?? (scope === "cwd" ? caller?.cwd : undefined);
    const parentFilter = args.parentAgentId ?? (scope === "children" ? callerAgentId : undefined);
    if (scope === "children" && !parentFilter) {
      throw new Error("scope children needs an agent-scoped caller or parentAgentId");
    }
    const workspaceIds = await resolveScopeWorkspaceIds(scope, caller?.workspaceId);
    return (agent) =>
      (!cwdFilter || isSameOrDescendantPath(cwdFilter, agent.cwd)) &&
      (!parentFilter || getParentAgentIdFromLabels(agent.labels) === parentFilter) &&
      (!workspaceIds || (agent.workspaceId !== undefined && workspaceIds.has(agent.workspaceId)));
  }

  async function resolveScopeWorkspaceIds(
    scope: NonNullable<ListAgentsArgs["scope"]>,
    callerWorkspaceId: string | undefined,
  ): Promise<Set<string> | null> {
    if (scope !== "workspace" && scope !== "project") return null;
    if (!callerWorkspaceId) {
      throw new Error(`scope ${scope} needs an agent-scoped caller with a workspace`);
    }
    if (scope === "workspace" || !options.workspaceRegistry) {
      return new Set([callerWorkspaceId]);
    }
    const projectId = (await options.workspaceRegistry.get(callerWorkspaceId))?.projectId;
    if (!projectId) return new Set([callerWorkspaceId]);
    const workspaces = await options.workspaceRegistry.list();
    return new Set(
      workspaces
        .filter((workspace) => workspace.projectId === projectId)
        .map((workspace) => workspace.workspaceId),
    );
  }

  registerTool(
    "cancel_agent",
    {
      title: "Cancel agent run",
      description:
        "Abort the agent's current run but keep the agent alive for future tasks. Your pending notification for its result is dropped.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        status: z.enum(["cancel_requested", "not_running"]).optional(),
      },
    },
    async ({ agentId }) => {
      if (callerAgentId && options.delegations) {
        await options.delegations.disposeChildTasks({
          parentAgentId: callerAgentId,
          childAgentId: agentId,
        });
      }
      const { cancelled } = await cancelAgentRunCommand(
        { agentManager, logger: childLogger },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          success: cancelled,
          status: cancelled ? "cancel_requested" : "not_running",
        }),
      };
    },
  );

  registerTool(
    "archive_agent",
    {
      title: "Archive agent",
      description:
        "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await archiveAgentCommand(
        {
          agentManager,
          agentStorage,
          logger: childLogger,
        },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "kill_agent",
    {
      title: "Kill agent",
      description: "Terminate an agent session permanently.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await closeAgentCommand({ agentManager }, agentId);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent name, labels, and/or runtime settings.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
        settings: UpdateAgentSettingsInputSchema.optional().describe(
          "Runtime settings to apply to the agent.",
        ),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, name, labels, settings }) => {
      if (settings?.modeId !== undefined) {
        await agentManager.setAgentMode(agentId, settings.modeId);
      }
      if (settings?.model !== undefined) {
        await agentManager.setAgentModel(agentId, settings.model);
      }
      if (settings?.thinkingOptionId !== undefined) {
        await agentManager.setAgentThinkingOption(agentId, settings.thinkingOptionId);
      }
      if (settings?.features) {
        for (const [featureId, value] of Object.entries(settings.features)) {
          await agentManager.setAgentFeature(agentId, featureId, value);
        }
      }

      await updateAgentCommand({ agentManager }, { agentId, name, labels });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "rename_workspace",
    {
      title: "Rename workspace",
      description:
        "Rename a workspace by setting its user-visible title. Omit workspaceId to rename your current workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Workspace id to rename. Omit to rename your current workspace."),
        title: z
          .string()
          .trim()
          .min(1, "title is required")
          .describe("New user-visible workspace title."),
      },
      outputSchema: {
        success: z.boolean(),
        workspaceId: z.string(),
        title: z.string(),
      },
    },
    async ({ workspaceId: requestedWorkspaceId, title }) => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is required to rename workspaces");
      }
      if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
        throw new Error("Workspace update emitter is required to rename workspaces");
      }

      const workspaceId = resolveWorkspaceIdForRename(requestedWorkspaceId);
      const existing = await options.workspaceRegistry.get(workspaceId);
      if (!existing) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }
      if (existing.archivedAt) {
        throw new Error(`Workspace ${workspaceId} is archived`);
      }

      await options.workspaceRegistry.upsert({
        ...existing,
        title,
        updatedAt: new Date().toISOString(),
      });
      await options.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);

      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          workspaceId,
          title,
        }),
      };
    },
  );

  registerTool(
    "list_workspace_scripts",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List workspace scripts",
      description:
        "List configured workspace scripts and their lifecycle, service port, proxy URL, health, and terminal ID.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID whose configured scripts to list."),
      },
      outputSchema: {
        scripts: z.array(WorkspaceScriptPayloadSchema),
      },
    },
    async ({ workspaceId }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ scripts: await workspaceScripts.list(workspaceId) }),
      };
    },
  );

  registerTool(
    "start_workspace_script",
    {
      title: "Start workspace script",
      description:
        "Start one configured workspace script through Paseo's managed workspace-script launcher.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the configured script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to start."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.launch({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "stop_workspace_script",
    {
      title: "Stop workspace script",
      description: "Stop a running workspace script through its supervised terminal lifecycle.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the running script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to stop."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.stop({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "list_terminals",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List terminals",
      description: "List terminals for a working directory or across all working directories.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        all: z.boolean().optional().describe("List terminals across all working directories."),
      },
      outputSchema: {
        terminals: z.array(TerminalSummarySchema),
      },
    },
    async ({ cwd, all }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminals = all
        ? (
            await Promise.all(
              terminalManager.listDirectories().map(async (directory) =>
                (await terminalManager.getTerminals(directory)).map((terminal) => ({
                  id: terminal.id,
                  name: terminal.name,
                  cwd: terminal.cwd,
                })),
              ),
            )
          ).flat()
        : (await terminalManager.getTerminals(resolveScopedCwd(cwd, { required: true }))).map(
            (terminal) => ({
              id: terminal.id,
              name: terminal.name,
              cwd: terminal.cwd,
            }),
          );

      return {
        content: [],
        structuredContent: ensureValidJson({ terminals }),
      };
    },
  );

  registerTool(
    "create_terminal",
    {
      title: "Create terminal",
      description: "Create a terminal session for a working directory.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        name: z.string().optional().describe("Optional terminal name."),
      },
      outputSchema: TerminalSummarySchema.shape,
    },
    async ({ cwd, name }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const workspaceId = await resolveTerminalWorkspaceId(resolvedCwd);

      const terminal = await terminalManager.createTerminal({
        cwd: resolvedCwd,
        workspaceId,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          id: terminal.id,
          name: terminal.name,
          cwd: terminal.cwd,
        }),
      };
    },
  );

  registerTool(
    "kill_terminal",
    {
      title: "Kill terminal",
      description: "Kill an existing terminal session.",
      inputSchema: {
        terminalId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      terminal.kill();

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "capture_terminal",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "Capture terminal",
      description: "Capture plain-text terminal output lines from a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
        scrollback: z.boolean().optional(),
        stripAnsi: z.boolean().optional().default(true),
      },
      outputSchema: {
        terminalId: z.string(),
        lines: z.array(z.string()),
        totalLines: z.number().int().nonnegative(),
      },
    },
    async ({ terminalId, start, end, scrollback, stripAnsi = true }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      if (!terminalManager.getTerminal(terminalId)) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      const capture = await terminalManager.captureTerminal(terminalId, {
        start: scrollback ? 0 : start,
        end,
        stripAnsi,
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
        }),
      };
    },
  );

  registerTool(
    "send_terminal_keys",
    {
      title: "Send terminal keys",
      description: "Send literal text or special key tokens to a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        keys: z.string(),
        literal: z.boolean().optional(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId, keys, literal = false }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      terminal.send({
        type: "input",
        data: resolveTerminalKeyToken(keys, literal),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description: "Create a recurring schedule that starts a new agent on a cron cadence.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        provider: (callerAgentId ? AgentProviderEnum.optional() : AgentProviderEnum).describe(
          "Provider, or provider/model (for example: codex or codex/gpt-5.4). Defaults to the caller's provider in an agent-scoped session.",
        ),
        cwd: z.string().optional(),
        isolation: z.enum(["local", "worktree"]).optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, provider, cwd, isolation, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: resolveNewAgentScheduleTarget({ provider, cwd, isolation }),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "create_heartbeat",
    {
      title: "Create heartbeat",
      description: "Create a recurring heartbeat that sends you a prompt on a cron cadence.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      if (!callerAgentId) {
        throw new Error("create_heartbeat requires an agent-scoped session");
      }
      resolveCallerAgent();

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: { type: "agent", agentId: callerAgentId },
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "delete_heartbeat",
    {
      title: "Delete heartbeat",
      description: "Delete one of your heartbeats.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: { success: z.boolean() },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireCallerHeartbeat(id);
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "list_schedules",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List schedules",
      description: "List all schedules managed by the daemon.",
      inputSchema: {},
      outputSchema: {
        schedules: z.array(ScheduleSummarySchema),
      },
    },
    async () => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedules = (await scheduleService.list())
        .filter((schedule) => schedule.target.type === "new-agent")
        .map((schedule) => toScheduleSummary(schedule));
      return {
        content: [],
        structuredContent: ensureValidJson({ schedules }),
      };
    },
  );

  registerTool(
    "inspect_schedule",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "Inspect schedule",
      description: "Inspect a schedule and its run history.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedule = await requireScheduleTarget(id, "new-agent");
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "pause_schedule",
    {
      title: "Pause schedule",
      description: "Pause an active schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.pause(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "resume_schedule",
    {
      title: "Resume schedule",
      description: "Resume a paused schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.resume(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule permanently.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_schedule",
    {
      title: "Update schedule",
      description:
        "Update an existing schedule. Only provided fields are changed; omitted fields remain unchanged.",
      inputSchema: z
        .object({
          id: z.string(),
          cron: z.string().optional().describe("New cron expression."),
          timezone: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "IANA time zone for cron cadence; requires cron. For example: America/New_York.",
            ),
          name: z.string().nullable().optional().describe("New name (null to clear)."),
          prompt: z.string().trim().min(1).optional().describe("New prompt text."),
          maxRuns: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe("New max runs limit (null to clear)."),
          provider: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("New provider for new-agent target."),
          model: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New model for new-agent target (null to clear)."),
          mode: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New mode for new-agent target (null to clear)."),
          cwd: z.string().trim().min(1).optional().describe("New cwd for new-agent target."),
          expiresIn: z
            .string()
            .optional()
            .describe("New relative expiry duration (for example: 1h, 2d)."),
          clearExpires: z.boolean().optional().describe("Clear any schedule expiry."),
        })
        .passthrough(),
      outputSchema: StoredScheduleSchema.shape,
    },
    async (input) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(input.id, "new-agent");
      const schedule = await scheduleService.update(buildScheduleUpdateInput(input));

      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "schedule_logs",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "Schedule logs",
      description: "Get the run history (logs) for a schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        runs: z.array(ScheduleRunSchema),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      const runs = await scheduleService.logs(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ runs }),
      };
    },
  );

  registerTool(
    "run_schedule_once",
    {
      title: "Run schedule once",
      description: "Run a schedule immediately without changing its cron cadence.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireScheduleTarget(id, "new-agent");
      const schedule = await scheduleService.runOnce(id);
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "get_orchestration_capabilities",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "Get orchestration capabilities",
      description:
        "One call before delegating: every provider you can start a child on (provider aliases such as claude-work are separate accounts of the provider they extend), its health, models with thinking options, modes, agent profiles, wait limits, and which orchestration features this daemon has. Pass a provider as <id>/<model> to create_agent.",
      inputSchema: {
        provider: z
          .string()
          .optional()
          .describe("Limit to one provider id or alias, for example codex or claude-work."),
        includeModels: z.boolean().optional().default(true),
      },
      outputSchema: OrchestrationCapabilitiesSchema,
    },
    async ({ provider, includeModels = true }) => {
      const caller = callerAgentId ? agentManager.getAgent(callerAgentId) : null;
      const entries = await providerSnapshotManager.listProviders({
        wait: true,
        ...(caller ? { cwd: caller.cwd } : {}),
        ...(provider ? { providers: [provider] } : {}),
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          caller: caller
            ? {
                agentId: caller.id,
                provider: caller.provider,
                extends: providerSnapshotManager.getProviderExtends(caller.provider),
                model: caller.config.model ?? null,
                modeId: caller.currentModeId ?? null,
                workspaceId: caller.workspaceId ?? null,
              }
            : null,
          providers: entries.map((entry) => toProviderCapabilities(entry, includeModels)),
          agentProfiles: daemonConfigStore?.get().agentProfiles ?? [],
          limits: {
            maxWaitMs: resolveMaxWaitMs(),
            defaultWaitMs: Math.min(DEFAULT_AGENT_WAIT_MS, resolveMaxWaitMs()),
            maxPromptChars: MAX_PROMPT_CHARS,
          },
          features: {
            crossProviderSubagents: tools.has("create_agent"),
            waitForAgent: tools.has("wait_for_agent"),
            sendDeliveryModes: tools.has("send_agent_prompt"),
            clientRequestId: true,
            worktreeWorkspaces:
              tools.has("create_workspace") && Boolean(options.createPaseoWorktree),
            terminals: tools.has("create_terminal"),
            workspaceScripts: tools.has("start_workspace_script"),
            schedules: tools.has("create_schedule"),
            heartbeats: tools.has("create_heartbeat"),
            browser: tools.has("browser_navigate"),
            pullRequestWatch: tools.has("watch_pull_request"),
          },
        }),
      };
    },
  );

  function toProviderCapabilities(entry: ProviderSnapshotEntry, includeModels: boolean) {
    const constraints = [
      ...(entry.enabled ? [] : ["disabled"]),
      ...(entry.status === "ready"
        ? []
        : [entry.error ? `${entry.status}: ${entry.error}` : entry.status]),
    ];
    return {
      id: entry.provider,
      extends: providerSnapshotManager.getProviderExtends(entry.provider),
      label: entry.label ?? null,
      status: entry.status,
      canRunChild: constraints.length === 0,
      constraints,
      defaultModelId:
        (entry.models?.find((model) => model.isDefault) ?? entry.models?.[0])?.id ?? null,
      defaultModeId: entry.defaultModeId ?? null,
      modes: (entry.modes ?? []).map((mode) => ({
        id: mode.id,
        label: mode.label,
        unattended: mode.isUnattended ?? false,
      })),
      ...(includeModels
        ? {
            models: (entry.models ?? [])
              .filter((model) => model.isSelectable !== false)
              .map((model) => ({
                id: model.id,
                label: model.label,
                isDefault: model.isDefault ?? false,
                thinkingOptionIds: (model.thinkingOptions ?? []).map((option) => option.id),
                defaultThinkingOptionId: model.defaultThinkingOptionId ?? null,
              })),
          }
        : {}),
    };
  }

  registerTool(
    "list_providers",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List providers",
      description: "List configured agent providers, availability, and their modes.",
      inputSchema: {},
      outputSchema: {
        providers: z.array(ProviderSummarySchema),
      },
    },
    async () => {
      const providers = (await providerSnapshotManager.listProviders({ wait: true })).map(
        toProviderSummary,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ providers }),
      };
    },
  );

  registerTool(
    "list_models",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List models",
      description: "List models for an agent provider.",
      inputSchema: {
        provider: AgentProviderEnum,
      },
      outputSchema: {
        provider: z.string(),
        models: z.array(AgentModelSchema),
      },
    },
    async ({ provider }) => {
      const models = await providerSnapshotManager.listModels({
        provider,
        wait: true,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider,
          models,
        }),
      };
    },
  );

  registerTool(
    "list_profiles",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List agent profiles",
      description:
        "List agent profiles: named provider/model/mode bundles a human configured for specific " +
        "kinds of work. Read each profile's `notes` to pick the one that fits the task you're " +
        "delegating, then copy its `provider`, `model`, `modeId`, `thinkingOptionId`, and " +
        "`featureValues` into create_agent (there is no `profile` parameter). Returns an empty " +
        "list if none are configured.",
      inputSchema: {},
      outputSchema: {
        profiles: z.array(AgentProfileSchema),
      },
    },
    async () => {
      const profiles = daemonConfigStore?.get().agentProfiles ?? [];
      return {
        content: [],
        structuredContent: ensureValidJson({ profiles }),
      };
    },
  );

  registerTool(
    "inspect_provider",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "Inspect provider",
      description:
        "Inspect compact provider capabilities for orchestration, including modes and draft feature settings. Use list_models for the full model list.",
      inputSchema: inspectProviderInputSchema,
      outputSchema: {
        provider: AgentProviderEnum,
        label: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        enabled: z.boolean(),
        status: z.string(),
        modes: z.array(ProviderModeSchema).nullish(),
        selectedModel: z.string().nullable(),
        features: z.array(AgentFeatureSchema),
      },
    },
    async ({ provider, cwd, settings }) => {
      const resolvedProviderModel = resolveScheduleProviderAndModel({
        provider,
        defaultProvider: provider,
      });
      const providerId = resolvedProviderModel.provider;
      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const entry = await providerSnapshotManager.getProvider({
        cwd: resolvedCwd,
        provider: providerId,
        wait: true,
      });
      const summary = toProviderSummary(entry);
      if (!entry.enabled) {
        throw new Error(`Provider '${providerId}' is disabled`);
      }
      if (entry.status !== "ready") {
        throw new Error(entry.error ?? `Provider '${providerId}' is unavailable`);
      }
      const selectedModel = settings?.model ?? resolvedProviderModel.model;
      const features = await agentManager.listDraftFeatures({
        provider: providerId,
        cwd: resolvedCwd,
        ...(settings?.modeId ? { modeId: settings.modeId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(settings?.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
        ...(settings?.features ? { featureValues: settings.features } : {}),
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider: providerId,
          label: summary.label,
          description: summary.description,
          enabled: summary.enabled,
          status: summary.status,
          modes: summary.modes,
          selectedModel: selectedModel ?? null,
          features,
        }),
      };
    },
  );

  registerTool(
    "get_agent_activity",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "Get agent activity",
      description:
        "Read an agent's timeline. Without paging fields, returns recent entries as a curated summary. Pass view, afterPosition, or itemPosition for paged items: afterPosition reads forward from a position (0 for the start, nextPosition from the previous page), itemPosition with textOffset continues one long item. Reading your delegated agent's final message whole means you will not also be notified of it.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe(
            "Summary: number of most recent activities. Paged: items per page (default 50, max 100).",
          ),
        view: z
          .enum(["activity", "messages"])
          .optional()
          .describe("Paged read. messages: only user and assistant messages. Default activity."),
        afterPosition: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Paged read of items after this position. Omit for the latest page."),
        epoch: z
          .string()
          .optional()
          .describe(
            "epoch from the previous page; a changed timeline restarts at the latest page.",
          ),
        maxCharsPerItem: z
          .number()
          .int()
          .positive()
          .max(MAX_CHARS_PER_ITEM)
          .optional()
          .describe(`Per-item text cap. Default ${DEFAULT_MAX_CHARS_PER_ITEM}.`),
        itemPosition: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Read only the item at this position, from textOffset."),
        textOffset: z.number().int().nonnegative().optional(),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
        epoch: z.string().optional(),
        reset: z.boolean().optional(),
        items: z
          .array(
            z.object({
              position: z.number(),
              kind: z.string(),
              text: z.string(),
              textOffset: z.number(),
              textTruncated: z.boolean(),
              nextTextOffset: z.number().optional(),
            }),
          )
          .optional(),
        nextPosition: z.number().optional(),
        hasMore: z.boolean().optional(),
        hasOlder: z.boolean().optional(),
      },
    },
    async (args: GetAgentActivityArgs) => {
      await ensureAgentLoaded(args.agentId, {
        agentManager,
        agentStorage,
        logger: childLogger,
      });
      const paged =
        args.view !== undefined ||
        args.afterPosition !== undefined ||
        args.itemPosition !== undefined;
      return paged ? await readPagedActivity(args) : await readActivitySummary(args);
    },
  );

  async function readActivitySummary({ agentId, limit }: GetAgentActivityArgs) {
    const timeline = agentManager.getTimeline(agentId);
    const snapshot = agentManager.getAgent(agentId);

    const selection = selectItemsByProjectedLimit({
      items: timeline,
      direction: "tail",
      limit: limit ?? 0,
    });
    const curatedContent = curateAgentActivity(selection.items);
    const { totalProjected, shownProjected } = selection;
    const finalAssistantMessage = timeline.findLast((item) => item.type === "assistant_message");
    if (finalAssistantMessage && selection.items.includes(finalAssistantMessage)) {
      await readDelegatedResult(agentId);
    }

    const noun = totalProjected === 1 ? "activity" : "activities";
    const countHeader =
      limit && shownProjected < totalProjected
        ? `Showing ${shownProjected} of ${totalProjected} ${noun} (limited to ${limit})`
        : `Showing all ${totalProjected} ${noun}`;

    return {
      content: [],
      structuredContent: ensureValidJson({
        agentId,
        updateCount: timeline.length,
        currentModeId: snapshot?.currentModeId ?? null,
        content: `${countHeader}\n\n${curatedContent}`,
      }),
    };
  }

  async function readPagedActivity(args: GetAgentActivityArgs) {
    const { agentId } = args;
    const timeline = agentManager.fetchTimeline(agentId, { direction: "tail", limit: 0 });
    const reset = args.epoch !== undefined && args.epoch !== timeline.epoch;
    const page = readActivityPage({
      rows: timeline.rows,
      view: args.view ?? "activity",
      ...(reset ? {} : { afterPosition: args.afterPosition, itemPosition: args.itemPosition }),
      textOffset: args.textOffset,
      limit: Math.min(
        MAX_ACTIVITY_PAGE_LIMIT,
        Math.max(1, args.limit ?? DEFAULT_ACTIVITY_PAGE_LIMIT),
      ),
      maxCharsPerItem: args.maxCharsPerItem ?? DEFAULT_MAX_CHARS_PER_ITEM,
    });
    if (page.includesFinalAssistantMessage) {
      await readDelegatedResult(agentId);
    }
    return {
      content: [],
      structuredContent: ensureValidJson({
        agentId,
        updateCount: timeline.rows.length,
        currentModeId: agentManager.getAgent(agentId)?.currentModeId ?? null,
        content: describeActivityPage(page),
        epoch: timeline.epoch,
        ...(reset ? { reset: true } : {}),
        items: page.items,
        nextPosition: page.nextPosition,
        hasMore: page.hasMore,
        hasOlder: page.hasOlder,
      }),
    };
  }

  registerTool(
    "set_agent_mode",
    {
      title: "Set agent session mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: {
        agentId: z.string(),
        modeId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        newMode: z.string(),
      },
    },
    async ({ agentId, modeId }) => {
      const result = await setAgentModeCommand({ agentManager }, { agentId, modeId });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true, newMode: result.modeId }),
      };
    },
  );

  registerTool(
    "list_pending_permissions",
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      title: "List pending permissions",
      description:
        "Return all pending permission requests across all agents with the normalized payloads.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string(),
            status: AgentStatusEnum,
            request: AgentPermissionRequestPayloadSchema,
          }),
        ),
      },
    },
    async () => {
      const permissions = agentManager.listAgents().flatMap((agent) => {
        const payload = toAgentPayload(agent);
        return payload.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: payload.status,
          request: sanitizePermissionRequest(request),
        }));
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ permissions }),
      };
    },
  );

  registerTool(
    "respond_to_permission",
    {
      title: "Respond to permission",
      description:
        "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, requestId, response }) => {
      if (response.behavior === "allow") {
        const refusal = callerContext?.authorizePermissionApproval?.();
        if (refusal) throw new Error(refusal);
      }
      await respondToAgentPermission({
        agentManager,
        agentId,
        requestId,
        response,
        logger: childLogger,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  return toCatalog();
}

interface ArchiveWorktreeCommandContext {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager | null;
  logger: Logger;
}

function archiveWorktreeDependencies(
  options: PaseoToolHostDependencies,
  context: ArchiveWorktreeCommandContext,
): ArchiveCommandDependencies {
  if (!options.github) {
    throw new Error("GitHub service is required to archive worktrees");
  }
  if (!options.workspaceGitService) {
    throw new Error("WorkspaceGitService is required to archive worktrees");
  }
  if (!options.archiveWorkspaceRecord) {
    throw new Error("Workspace registry archiver is required to archive worktrees");
  }
  if (!options.findWorkspaceIdForCwd) {
    throw new Error("Workspace resolver is required to archive worktrees");
  }
  if (!options.listActiveWorkspaces) {
    throw new Error("Active workspace lister is required to archive worktrees");
  }
  if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
    throw new Error("Workspace update emitter is required to archive worktrees");
  }
  if (!options.markWorkspaceArchiving) {
    throw new Error("Workspace archiving marker is required to archive worktrees");
  }
  if (!options.clearWorkspaceArchiving) {
    throw new Error("Workspace archiving clearer is required to archive worktrees");
  }
  return {
    paseoHome: options.paseoHome,
    paseoWorktreesBaseRoot: options.worktreesRoot,
    github: options.github,
    workspaceGitService: options.workspaceGitService,
    agentManager: context.agentManager,
    agentStorage: context.agentStorage,
    findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
    listActiveWorkspaces: options.listActiveWorkspaces,
    archiveWorkspaceRecord: options.archiveWorkspaceRecord,
    emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
    markWorkspaceArchiving: options.markWorkspaceArchiving,
    clearWorkspaceArchiving: options.clearWorkspaceArchiving,
    killTerminalsForWorkspace: (workspaceId: string) =>
      killTerminalsForWorkspace(
        {
          terminalManager: context.terminalManager,
          sessionLogger: context.logger,
        },
        workspaceId,
      ),
    sessionLogger: context.logger,
  };
}
