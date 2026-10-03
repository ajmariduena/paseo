import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type pino from "pino";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import { isPaseoToolName, isSpeakToolName } from "@getpaseo/protocol/tool-name-normalization";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentPermissionRequest, AgentProvider } from "../agent/agent-sdk-types.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { VoiceNoticeQueue, type VoiceNotice, type VoiceNoticeReason } from "./notice-queue.js";
import {
  VOICE_ORCHESTRATOR_SYSTEM_PROMPT,
  buildCallStartPrompt,
  buildNoticePrompt,
  clipForSpeech,
  type VoiceFleetEntry,
} from "./prompt.js";
import { isSpokenApproval } from "./spoken-approval.js";

export const VOICE_ORCHESTRATOR_LABEL = "paseo.voice";
const STATE_FILENAME = "orchestrator.json";
const FLEET_LIMIT = 12;
const FLEET_RECENT_MS = 12 * 60 * 60 * 1000;
const APPROVAL_WINDOW_MS = 90_000;

const OrchestratorStateSchema = z.object({ agentId: z.guid() });

export interface VoiceOrchestratorCall {
  isUserSpeaking(): boolean;
}

export interface VoiceOrchestratorOptions {
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: WorkspaceRegistry | null;
  provider?: AgentProvider | null;
  model?: string | null;
  logger: pino.Logger;
}

/**
 * Owns the daemon's single voice orchestrator agent: an internal agent that drives
 * the other agents through the Paseo tools during a global voice call, and the
 * queue of agent events it announces while a call is attached.
 */
export class VoiceOrchestrator {
  private readonly logger: pino.Logger;
  private agentIdPromise: Promise<string> | null = null;
  private knownAgentId: string | null = null;
  private ensurePromise: Promise<string> | null = null;
  private call: VoiceOrchestratorCall | null = null;
  private queue: VoiceNoticeQueue | null = null;
  private unsubscribeSelf: (() => void) | null = null;
  private lastUtterance: { text: string; at: number; approvalUsed: boolean } | null = null;
  private preferredLanguage: string | null = null;

  constructor(private readonly options: VoiceOrchestratorOptions) {
    this.logger = options.logger.child({ module: "voice-orchestrator" });
    void this.resolveAgentId().catch((error) => {
      this.agentIdPromise = null;
      this.logger.warn({ err: error }, "Failed to load voice orchestrator id");
    });
  }

  isOrchestrator(agentId: string): boolean {
    return this.knownAgentId === agentId;
  }

  async matches(agentId: string): Promise<boolean> {
    return (await this.resolveAgentId()) === agentId;
  }

  setPreferredLanguage(language: string | null): void {
    this.preferredLanguage = language?.trim() || null;
  }

  async ensureAgent(): Promise<string> {
    if (!this.options.agentManager.hasPaseoTools()) {
      throw new Error(
        "The voice assistant needs the Paseo tools. Turn on daemon.mcp.injectIntoAgents in this host's config.",
      );
    }
    const agentId = await this.resolveAgentId();
    const existing = this.options.agentManager.getAgent(agentId);
    if (existing && existing.lifecycle !== "closed") {
      return agentId;
    }
    this.ensurePromise ??= this.createAgent(agentId).finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  attachCall(call: VoiceOrchestratorCall): () => void {
    this.detachCurrentCall();
    this.call = call;
    this.lastUtterance = null;
    const queue = new VoiceNoticeQueue({
      batchWindowMs: 4_000,
      urgentDelayMs: 750,
      busyRetryMs: 1_000,
      isBusy: () => this.isBusy(),
      isStale: (notice) => this.isNoticeStale(notice),
      deliver: (notices) => this.deliverNotices(notices),
    });
    this.queue = queue;
    void this.sendCallStart(call);
    return () => {
      if (this.call !== call) return;
      this.detachCurrentCall();
    };
  }

  handleAttention(params: { agentId: string; reason: VoiceNoticeReason }): void {
    if (!this.queue || this.isOrchestrator(params.agentId)) return;
    this.queue.push({ agentId: params.agentId, reason: params.reason });
  }

  noteUserUtterance(text: string): void {
    this.lastUtterance = { text, at: Date.now(), approvalUsed: false };
  }

  /** Returns a refusal message unless the user's latest words approve a single permission. */
  authorizePermissionApproval(): string | null {
    const utterance = this.lastUtterance;
    if (
      !utterance ||
      utterance.approvalUsed ||
      Date.now() - utterance.at > APPROVAL_WINDOW_MS ||
      !isSpokenApproval(utterance.text)
    ) {
      return "Approval needs the user's spoken yes. Describe the request and ask the user to say yes first.";
    }
    utterance.approvalUsed = true;
    return null;
  }

  dispose(): void {
    this.detachCurrentCall();
  }

  private detachCurrentCall(): void {
    this.queue?.close();
    this.queue = null;
    this.call = null;
    this.lastUtterance = null;
  }

  private async resolveAgentId(): Promise<string> {
    this.agentIdPromise ??= this.loadOrCreateAgentId();
    const agentId = await this.agentIdPromise;
    this.knownAgentId = agentId;
    return agentId;
  }

  private async loadOrCreateAgentId(): Promise<string> {
    const dir = this.orchestratorDir();
    const path = join(dir, STATE_FILENAME);
    try {
      const parsed = OrchestratorStateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (parsed.success) return parsed.data.agentId;
    } catch {
      // Missing or unreadable state: mint a new id below.
    }
    const agentId = uuidv4();
    await mkdir(dir, { recursive: true });
    await writeFile(path, `${JSON.stringify({ agentId }, null, 2)}\n`, "utf8");
    return agentId;
  }

  private orchestratorDir(): string {
    return join(this.options.paseoHome, "voice");
  }

  private async createAgent(agentId: string): Promise<string> {
    const cwd = this.orchestratorDir();
    await mkdir(cwd, { recursive: true });
    const provider = this.options.provider ?? "claude";
    const model = this.options.model ?? (provider === "claude" ? "sonnet" : undefined);
    this.logger.info({ agentId, provider, model }, "Creating voice orchestrator agent");
    await this.options.agentManager.createAgent(
      {
        provider,
        cwd,
        ...(model ? { model } : {}),
        title: "Voice",
        systemPrompt: VOICE_ORCHESTRATOR_SYSTEM_PROMPT,
        internal: true,
      },
      agentId,
      { workspaceId: undefined, labels: { [VOICE_ORCHESTRATOR_LABEL]: "orchestrator" } },
    );
    this.unsubscribeSelf?.();
    this.unsubscribeSelf = this.options.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_requested") {
          void this.answerOwnPermission(agentId, event.event.request);
        }
      },
      { agentId, replayState: false },
    );
    return agentId;
  }

  private async answerOwnPermission(
    agentId: string,
    request: AgentPermissionRequest,
  ): Promise<void> {
    const allowed =
      request.kind === "tool" && (isSpeakToolName(request.name) || isPaseoToolName(request.name));
    try {
      await this.options.agentManager.respondToPermission(
        agentId,
        request.id,
        allowed
          ? { behavior: "allow" }
          : {
              behavior: "deny",
              message: "The voice assistant can only use the Paseo tools.",
            },
      );
    } catch (error) {
      this.logger.warn({ err: error, requestId: request.id }, "Failed to answer own permission");
    }
  }

  private isBusy(): boolean {
    if (this.call?.isUserSpeaking()) return true;
    const agentId = this.knownAgentId;
    const agent = agentId ? this.options.agentManager.getAgent(agentId) : null;
    return agent?.lifecycle === "running" || agent?.lifecycle === "initializing";
  }

  private isNoticeStale(notice: VoiceNotice): boolean {
    const agent = this.options.agentManager.getAgent(notice.agentId);
    if (!agent || agent.lifecycle === "closed") return true;
    switch (notice.reason) {
      case "permission":
        return agent.pendingPermissions.size === 0;
      case "error":
        return agent.lifecycle !== "error";
      case "finished":
        return agent.lifecycle === "running";
    }
  }

  private async sendCallStart(call: VoiceOrchestratorCall): Promise<void> {
    try {
      const agentId = await this.ensureAgent();
      const fleet = await this.describeFleet();
      if (this.call !== call) return;
      await this.sendPrompt(
        agentId,
        buildCallStartPrompt({ fleet, language: this.preferredLanguage }),
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to start voice orchestrator call");
    }
  }

  private async deliverNotices(notices: VoiceNotice[]): Promise<void> {
    const lines: string[] = [];
    for (const notice of notices) {
      const line = await this.describeNotice(notice);
      if (line) lines.push(line);
    }
    if (lines.length === 0 || !this.knownAgentId) return;
    try {
      await this.sendPrompt(this.knownAgentId, buildNoticePrompt(lines));
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to deliver voice notices");
    }
  }

  private async sendPrompt(agentId: string, text: string): Promise<void> {
    await sendPromptToAgent({
      agentManager: this.options.agentManager,
      agentStorage: this.options.agentStorage,
      agentId,
      prompt: text,
      unarchive: false,
      logger: this.logger,
    });
  }

  private async describeNotice(notice: VoiceNotice): Promise<string | null> {
    const agent = this.options.agentManager.getAgent(notice.agentId);
    if (!agent) return null;
    const name = await this.describeAgentName(agent);
    switch (notice.reason) {
      case "permission": {
        const request = [...agent.pendingPermissions.values()].at(-1);
        if (!request) return null;
        const what = clipForSpeech(
          [request.title ?? request.name, request.description].filter(Boolean).join(": "),
          200,
        );
        return `${name} is waiting for permission: ${what}`;
      }
      case "error":
        return `${name} failed: ${clipForSpeech(agent.lastError ?? "unknown error", 200)}`;
      case "finished": {
        const message = await this.options.agentManager
          .getLastAssistantMessage(agent.id)
          .catch(() => null);
        return message
          ? `${name} finished. Its last message: ${clipForSpeech(message, 320)}`
          : `${name} finished.`;
      }
    }
  }

  private async describeFleet(): Promise<VoiceFleetEntry[]> {
    const now = Date.now();
    const candidates = this.options.agentManager
      .listAgents()
      .filter(
        (agent) =>
          !this.isOrchestrator(agent.id) &&
          agent.lifecycle !== "closed" &&
          !isDelegatedAgent(agent) &&
          (agent.lifecycle === "running" ||
            agent.attention.requiresAttention ||
            agent.pendingPermissions.size > 0 ||
            now - agent.updatedAt.getTime() < FLEET_RECENT_MS),
      )
      .sort((left, right) => fleetRank(left) - fleetRank(right))
      .slice(0, FLEET_LIMIT);
    return Promise.all(
      candidates.map(async (agent) => ({
        workspace: await this.describeWorkspace(agent),
        title: agent.config.title?.trim() || "Untitled agent",
        status: describeStatus(agent),
      })),
    );
  }

  private async describeAgentName(agent: ManagedAgent): Promise<string> {
    const title = agent.config.title?.trim() || "an agent";
    return `${await this.describeWorkspace(agent)} · ${title}`;
  }

  private async describeWorkspace(agent: ManagedAgent): Promise<string> {
    if (agent.workspaceId && this.options.workspaceRegistry) {
      const record = await this.options.workspaceRegistry.get(agent.workspaceId).catch(() => null);
      if (record) return record.title ?? record.displayName;
    }
    return basename(agent.cwd);
  }
}

function fleetRank(agent: ManagedAgent): number {
  if (agent.pendingPermissions.size > 0) return 0;
  if (agent.lifecycle === "error") return 1;
  if (agent.attention.requiresAttention) return 2;
  if (agent.lifecycle === "running") return 3;
  return 4;
}

function describeStatus(agent: ManagedAgent): string {
  if (agent.pendingPermissions.size > 0) return "waiting for permission";
  if (agent.lifecycle === "error") return "failed";
  if (agent.lifecycle === "running") return "working";
  if (agent.attention.requiresAttention && agent.attention.attentionReason === "finished") {
    return "finished, not reviewed yet";
  }
  return "idle";
}
