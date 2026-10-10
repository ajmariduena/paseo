import type pino from "pino";
import type { VoiceToolResult } from "@getpaseo/protocol/voice-fleet/types";
import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { PaseoToolCatalog, PaseoToolResult } from "../../agent/tools/types.js";
import { respondToAgentPermission } from "../../agent/permission-response.js";
import { describePermission } from "../digest/agent-digest.js";
import { speakableClip, toSpeakableText } from "../speakable.js";
import { formatHostHealth, summarizeHostHealth } from "../fleet/host-health.js";
import {
  resolveAgentSelection,
  type AgentSelection,
  type SelectableModel,
} from "./agent-selection.js";

/** What the user picked in the app for new agents; the call applies it to agents it creates. */
export interface VoiceAgentDefaults {
  provider?: string;
  models?: Record<string, string>;
  thinking?: Record<string, string>;
}

export interface VoiceToolboxOptions {
  catalog: () => Promise<PaseoToolCatalog>;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  hostMetrics: (() => Promise<HostMetricsSnapshot>) | null;
  hostLabel: () => string;
  defaults: () => VoiceAgentDefaults;
  logger: pino.Logger;
}

const DELIVERY_WORDS: Record<string, string> = {
  steered: "added to the work it is doing now",
  queued: "queued; it runs after its current task",
  restarted: "it stopped what it was doing and started on this",
};

// The same instruction to the same agent this soon is the user repeating a request whose
// confirmation they didn't hear yet, not a new one.
const REPEAT_WINDOW_MS = 120_000;
const REPEAT_SIMILARITY = 0.6;

// A courier retry of the same operation must not act twice.
const OPERATION_TTL_MS = 10 * 60 * 1000;
const READ_DETAIL_MAX = 6_000;

export class VoiceToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceToolError";
  }
}

/**
 * The voice call's hands on one host. Every tool takes real ids (the router resolves the
 * model's short refs) and returns plain facts for the voice model. Runs the same way for the
 * host running the call and, through the phone, for every other host.
 */
export class VoiceToolbox {
  private recentSends: Array<{ agentId: string; words: Set<string>; at: number }> = [];
  private readonly operations = new Map<
    string,
    { at: number; fingerprint: string; result: Promise<VoiceToolResult> }
  >();

  constructor(private readonly options: VoiceToolboxOptions) {}

  execute(params: {
    operationId: string;
    tool: string;
    args: Record<string, unknown>;
  }): Promise<VoiceToolResult> {
    this.pruneOperations();
    const fingerprint = JSON.stringify([params.tool, params.args]);
    const existing = this.operations.get(params.operationId);
    if (existing) {
      // A retry gets the first result; the same id for another action is a caller bug.
      if (existing.fingerprint === fingerprint) return existing.result;
      return Promise.resolve({
        ok: false,
        text: "Not run: this operation id was already used for a different action.",
      });
    }
    const result = this.run(params.tool, params.args, params.operationId).catch(
      (error: unknown): VoiceToolResult => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.warn(
          { err: error, tool: params.tool, operationId: params.operationId },
          "Voice tool failed",
        );
        return { ok: false, text: `It failed: ${speakableClip(message, 240)}` };
      },
    );
    this.operations.set(params.operationId, { at: Date.now(), fingerprint, result });
    return result;
  }

  /** Names of the available providers and their models, for the call's vocabulary. */
  async modelNames(): Promise<string[]> {
    const listed = (await this.callCatalog("list_providers", {})) as {
      providers?: Array<{ id: string; label: string; enabled: boolean; status: string }>;
    };
    const available = (listed.providers ?? []).filter(
      (provider) => provider.enabled && provider.status === "available",
    );
    const names = available.map((provider) => provider.label);
    await Promise.all(
      available.map(async (provider) => {
        const models = (await this.callCatalog("list_models", { provider: provider.id }).catch(
          () => null,
        )) as { models?: Array<{ label: string }> } | null;
        for (const model of models?.models ?? []) names.push(model.label);
      }),
    );
    return names;
  }

  /**
   * Provider snapshots load lazily and the first listing can take seconds; a call warms them
   * so the first agent created by voice doesn't wait.
   */
  prewarm(): void {
    void this.callCatalog("list_providers", {}).catch((error: unknown) => {
      this.options.logger.debug({ err: error }, "Voice tools prewarm failed");
    });
  }

  /** Milliseconds since a near-identical message went to this agent, or null. */
  private findRecentSend(agentId: string, message: string): number | null {
    const now = Date.now();
    const words = messageWords(message);
    for (const sent of this.recentSends) {
      if (sent.agentId !== agentId || now - sent.at > REPEAT_WINDOW_MS) continue;
      if (similarity(words, sent.words) >= REPEAT_SIMILARITY) return now - sent.at;
    }
    return null;
  }

  private rememberSend(agentId: string, message: string): void {
    const now = Date.now();
    this.recentSends = this.recentSends.filter((sent) => now - sent.at <= REPEAT_WINDOW_MS);
    this.recentSends.push({ agentId, words: messageWords(message), at: now });
  }

  private pruneOperations(): void {
    const cutoff = Date.now() - OPERATION_TTL_MS;
    for (const [id, entry] of this.operations) {
      if (entry.at < cutoff) this.operations.delete(id);
    }
  }

  // eslint-disable-next-line complexity
  private async run(
    tool: string,
    args: Record<string, unknown>,
    operationId: string,
  ): Promise<VoiceToolResult> {
    switch (tool) {
      case "send_message":
        return this.sendMessage({
          agentId: requireString(args, "agentId"),
          message: requireString(args, "message"),
          interrupt: args.interrupt === true,
          operationId,
        });
      case "start_agent":
        return this.startAgent(args, operationId);
      case "create_workspace":
        return this.createWorkspaceOnly(args);
      case "answer_permission":
        return this.answerPermission({
          agentId: requireString(args, "agentId"),
          allow: args.allow === true,
          requestId: optionalString(args, "requestId"),
          note: optionalString(args, "note"),
        });
      case "stop_agent":
        return this.stopAgent(requireString(args, "agentId"));
      case "archive_agent":
        return this.archiveAgent(requireString(args, "agentId"));
      case "archive_workspace":
        return this.archiveWorkspace(requireString(args, "workspaceId"));
      case "read_agent":
        return this.readAgent(requireString(args, "agentId"));
      case "set_agent_mode":
        return this.setAgentMode(requireString(args, "agentId"), requireString(args, "mode"));
      case "rename_agent":
        return this.renameAgent(requireString(args, "agentId"), requireString(args, "title"));
      case "rename_workspace":
        return this.renameWorkspace(
          requireString(args, "workspaceId"),
          requireString(args, "title"),
        );
      case "create_note":
        return this.createNote(requireString(args, "title"), optionalString(args, "body"));
      case "list_notes":
        return this.listNotes();
      case "host_health":
        return this.hostHealth();
      default:
        throw new VoiceToolError(`Unknown voice tool ${tool}`);
    }
  }

  private async callCatalog(name: string, input: Record<string, unknown>): Promise<unknown> {
    const catalog = await this.options.catalog();
    const result = await catalog.executeTool(name, input);
    if (result.isError) throw new VoiceToolError(resultText(result) || `${name} failed`);
    return result.structuredContent ?? resultText(result);
  }

  private async agentName(agentId: string): Promise<string> {
    const live = this.options.agentManager.getAgent(agentId);
    const title =
      live?.config.title?.trim() || (await this.options.agentStorage.get(agentId))?.title?.trim();
    return title ? `"${title}"` : "the agent";
  }

  private async sendMessage(params: {
    agentId: string;
    message: string;
    interrupt: boolean;
    operationId: string;
  }): Promise<VoiceToolResult> {
    const name = await this.agentName(params.agentId);
    const repeated = this.findRecentSend(params.agentId, params.message);
    if (repeated !== null) {
      // The user asked again because the first confirmation was slow; the agent already has it.
      return {
        ok: true,
        text: `${name} already got this message ${Math.max(1, Math.round(repeated / 1000))} seconds ago, so it was not sent again.`,
      };
    }
    const wasRunning = this.options.agentManager.getAgent(params.agentId)?.lifecycle === "running";
    const result = (await this.callCatalog("send_agent_prompt", {
      agentId: params.agentId,
      prompt: params.message,
      background: true,
      notifyOnFinish: false,
      delivery: params.interrupt ? "restart" : "auto",
      clientRequestId: params.operationId,
    })) as { disposition?: string } | string;
    this.rememberSend(params.agentId, params.message);
    const disposition = typeof result === "object" ? result.disposition : undefined;
    const how =
      (disposition ? DELIVERY_WORDS[disposition] : undefined) ??
      (wasRunning ? "delivered while it works" : "it started working on it");
    return {
      ok: true,
      text: `Sent to ${name} on ${this.options.hostLabel()}: ${how}. Paseo announces its result when it finishes.`,
    };
  }

  private async startAgent(
    args: Record<string, unknown>,
    operationId: string,
  ): Promise<VoiceToolResult> {
    const task = requireString(args, "task");
    const title = cleanTitle(requireString(args, "title"));
    // An explicit model or effort that doesn't exist here stops before anything is created.
    const selection = await this.resolveSelection(args);
    if (!selection.ok) return { ok: false, text: `Nothing was created: ${selection.reason}` };
    const place = await this.resolvePlace(args, title);
    const created = (await this.callCatalog("create_agent", {
      title,
      provider: `${selection.provider}/${selection.model}`,
      initialPrompt: task,
      workspaceId: place.workspaceId,
      background: true,
      notifyOnFinish: false,
      clientRequestId: operationId,
      ...(selection.thinking ? { settings: { thinkingOptionId: selection.thinking } } : {}),
    })) as { agentId?: string; status?: string; lastMessage?: string | null };
    if (!created.agentId || created.status === "error" || created.status === "closed") {
      const why = created.lastMessage ? `: ${speakableClip(created.lastMessage, 160)}` : "";
      return {
        ok: false,
        text: `The workspace "${place.title}" ${place.created ? "was created but" : "exists but"} the agent did not start${why}.`,
      };
    }
    const effort = selection.thinking ? ` at ${selection.thinking} effort` : "";
    return {
      ok: true,
      text: `Started "${title}" with ${selection.model}${effort} in ${place.created && place.worktree ? "a new worktree, " : ""}workspace "${place.title}" on ${this.options.hostLabel()}. It is working on it; Paseo announces the result.`,
      detail: `agentId ${created.agentId}`,
    };
  }

  private async createWorkspaceOnly(args: Record<string, unknown>): Promise<VoiceToolResult> {
    const title = cleanTitle(requireString(args, "title"));
    const place = await this.resolvePlace(args, title);
    return {
      ok: true,
      text: place.created
        ? `Created the ${place.worktree ? "worktree " : ""}workspace "${place.title}" on ${this.options.hostLabel()}, with no agent yet.`
        : `The workspace "${place.title}" already exists on ${this.options.hostLabel()}.`,
    };
  }

  private async resolvePlace(
    args: Record<string, unknown>,
    title: string,
  ): Promise<{ workspaceId: string; title: string; created: boolean; worktree: boolean }> {
    const existingId = optionalString(args, "workspaceId");
    if (existingId) {
      return {
        workspaceId: existingId,
        title: optionalString(args, "workspaceTitle") ?? "the workspace",
        created: false,
        worktree: false,
      };
    }
    const rootPath = requireString(args, "rootPath");
    const projectId = optionalString(args, "projectId");
    const newWorktree = args.newWorktree !== false;
    if (!newWorktree) {
      const existing = await this.findLocalCheckout(projectId, rootPath);
      if (existing) return { ...existing, created: false, worktree: false };
    }
    const created = (await this.callCatalog("create_workspace", {
      isolation: newWorktree ? "worktree" : "local",
      path: rootPath,
      ...(projectId ? { projectId } : {}),
      title,
    })) as { workspaceId?: string; title?: string | null };
    if (!created.workspaceId) throw new VoiceToolError("the workspace was not created");
    return {
      workspaceId: created.workspaceId,
      title: created.title ?? title,
      created: true,
      worktree: newWorktree,
    };
  }

  private async findLocalCheckout(
    projectId: string | undefined,
    rootPath: string,
  ): Promise<{ workspaceId: string; title: string } | null> {
    const listed = (await this.callCatalog("list_workspaces", {})) as {
      workspaces?: Array<{
        workspaceId: string;
        projectId: string;
        cwd: string;
        kind: string;
        title: string | null;
      }>;
    };
    const match = (listed.workspaces ?? []).find(
      (workspace) =>
        workspace.kind !== "worktree" &&
        (workspace.cwd === rootPath ||
          (projectId !== undefined && workspace.projectId === projectId)),
    );
    return match ? { workspaceId: match.workspaceId, title: match.title ?? rootPath } : null;
  }

  /** Provider, model and effort from what the user said, checked against this host's catalog. */
  private async resolveSelection(args: Record<string, unknown>): Promise<AgentSelection> {
    const defaults = isAgentDefaults(args.defaults) ? args.defaults : this.options.defaults();
    const request = {
      provider: optionalString(args, "provider"),
      model: optionalString(args, "model"),
      effort: optionalString(args, "effort"),
    };
    const listed = (await this.callCatalog("list_providers", {})) as {
      providers?: Array<{ id: string; enabled: boolean; status: string }>;
    };
    const available = (listed.providers ?? []).filter(
      (provider) => provider.enabled && provider.status === "available",
    );
    const needed =
      request.model || request.provider
        ? available
        : available.filter(
            (provider) =>
              provider.id === (defaults.provider ?? "claude") || provider.id === "claude",
          );
    const catalog: Record<string, SelectableModel[]> = {};
    await Promise.all(
      (needed.length > 0 ? needed : available).map(async (provider) => {
        const models = (await this.callCatalog("list_models", { provider: provider.id }).catch(
          () => null,
        )) as { models?: SelectableModel[] } | null;
        catalog[provider.id] = models?.models ?? [];
      }),
    );
    return resolveAgentSelection({ request, defaults, catalog });
  }

  private async answerPermission(params: {
    agentId: string;
    allow: boolean;
    requestId: string | undefined;
    note: string | undefined;
  }): Promise<VoiceToolResult> {
    const agent = this.options.agentManager.getAgent(params.agentId);
    const name = await this.agentName(params.agentId);
    const pending = agent ? [...agent.pendingPermissions.values()] : [];
    const latest = pending.at(-1);
    if (!agent || !latest) {
      return { ok: false, text: `${name} has no pending permission anymore.` };
    }
    // The user's yes was for the request they heard; a newer one needs its own yes.
    const request = params.requestId
      ? pending.find((entry) => entry.id === params.requestId)
      : latest;
    if (!request) {
      return {
        ok: false,
        text: `Not answered: the request the user heard is no longer pending. ${name} now asks to ${describePermission(latest)}; ask the user about that one.`,
      };
    }
    await respondToAgentPermission({
      agentManager: this.options.agentManager,
      agentId: params.agentId,
      requestId: request.id,
      response: params.allow
        ? { behavior: "allow" }
        : {
            behavior: "deny",
            ...(params.note ? { message: params.note } : {}),
          },
      logger: this.options.logger,
    });
    return {
      ok: true,
      text: `${params.allow ? "Approved" : "Denied"} ${name}'s request to ${describePermission(request)}.`,
    };
  }

  private async stopAgent(agentId: string): Promise<VoiceToolResult> {
    const name = await this.agentName(agentId);
    const result = (await this.callCatalog("cancel_agent", { agentId })) as { success?: boolean };
    return result.success
      ? { ok: true, text: `Stopped ${name}. It stays available for new instructions.` }
      : { ok: true, text: `${name} was not running.` };
  }

  private async archiveAgent(agentId: string): Promise<VoiceToolResult> {
    const name = await this.agentName(agentId);
    await this.callCatalog("archive_agent", { agentId });
    return { ok: true, text: `Archived the agent ${name}.` };
  }

  private async archiveWorkspace(workspaceId: string): Promise<VoiceToolResult> {
    const result = (await this.callCatalog("archive_workspace", { workspaceId })) as {
      archivedAgentIds?: string[];
      removedDirectory?: boolean;
    };
    const agents = result.archivedAgentIds?.length ?? 0;
    return {
      ok: true,
      text: `Archived the workspace${agents > 0 ? ` and its ${agents} agent${agents === 1 ? "" : "s"}` : ""}${result.removedDirectory ? "; its worktree was removed" : ""}.`,
    };
  }

  private async readAgent(agentId: string): Promise<VoiceToolResult> {
    const name = await this.agentName(agentId);
    const activity = await this.callCatalog("get_agent_activity", { agentId, limit: 30 });
    const text = typeof activity === "string" ? activity : JSON.stringify(activity);
    return {
      ok: true,
      text: `Recent activity of ${name}.`,
      detail: toSpeakableText(text).slice(-READ_DETAIL_MAX),
    };
  }

  private async setAgentMode(agentId: string, mode: string): Promise<VoiceToolResult> {
    const name = await this.agentName(agentId);
    const agent = this.options.agentManager.getAgent(agentId);
    const modes = agent?.availableModes ?? [];
    const wanted = mode.toLowerCase();
    const match =
      modes.find((entry) => entry.id.toLowerCase() === wanted) ??
      modes.find((entry) => entry.label.toLowerCase().includes(wanted)) ??
      modes.find((entry) => entry.id.toLowerCase().includes(wanted));
    if (modes.length > 0 && !match) {
      return {
        ok: false,
        text: `${name} has no mode "${mode}". Its modes: ${modes.map((entry) => entry.label).join(", ")}.`,
      };
    }
    await this.callCatalog("set_agent_mode", { agentId, modeId: match?.id ?? mode });
    const label = match?.label ?? mode;
    const suffix = /\bmode$/i.test(label) ? "" : " mode";
    return { ok: true, text: `${name} is now in ${label}${suffix}.` };
  }

  private async renameAgent(agentId: string, title: string): Promise<VoiceToolResult> {
    await this.callCatalog("update_agent", { agentId, name: title });
    return { ok: true, text: `Renamed the agent to "${title}".` };
  }

  private async renameWorkspace(workspaceId: string, title: string): Promise<VoiceToolResult> {
    await this.callCatalog("rename_workspace", { workspaceId, title });
    return { ok: true, text: `Renamed the workspace to "${title}".` };
  }

  private async createNote(title: string, body: string | undefined): Promise<VoiceToolResult> {
    await this.callCatalog("create_note", { title, ...(body ? { body } : {}) });
    return { ok: true, text: `Saved a note: "${title}".` };
  }

  private async listNotes(): Promise<VoiceToolResult> {
    const listed = (await this.callCatalog("list_notes", { includeDone: false })) as {
      notes?: Array<{ title: string; body?: string | null; createdAt?: string }>;
    };
    const notes = (listed.notes ?? []).slice(0, 12);
    if (notes.length === 0) return { ok: true, text: "There are no notes." };
    return {
      ok: true,
      text: `${notes.length} recent notes.`,
      detail: notes
        .map(
          (note) =>
            `- ${note.title}${note.body ? `: ${speakableClip(note.body, 160)}` : ""}${note.createdAt ? ` (${note.createdAt.slice(0, 10)})` : ""}`,
        )
        .join("\n"),
    };
  }

  private async hostHealth(): Promise<VoiceToolResult> {
    if (!this.options.hostMetrics) {
      return { ok: false, text: "This host does not report its health." };
    }
    const health = summarizeHostHealth(await this.options.hostMetrics());
    return { ok: true, text: `${formatHostHealth(this.options.hostLabel(), health)}.` };
  }
}

function messageWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

/**
 * Shared words over the longer message: a rephrasing of the same request scores high, a new
 * request that reuses a few words does not. Short messages only match when equal.
 */
function similarity(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const larger = Math.max(left.size, right.size);
  if (Math.min(left.size, right.size) < 3) return shared === larger ? 1 : 0;
  return shared / larger;
}

function cleanTitle(raw: string): string {
  return speakableClip(raw, 60).replace(/…$/, "") || "Voice task";
}

function isAgentDefaults(value: unknown): value is VoiceAgentDefaults {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultText(result: PaseoToolResult): string {
  return result.content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new VoiceToolError(`Missing ${key}`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
