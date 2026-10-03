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
import { buildVoiceModeSystemPrompt, wrapSpokenInput } from "../voice-config.js";
import type { VoiceCallerContext } from "../voice-types.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { VoiceMessagesSpeech } from "./messages/messages-call.js";
import { VoiceMessagesHub } from "./messages/messages-hub.js";
import { VoiceNoticeQueue, type VoiceNotice, type VoiceNoticeReason } from "./notice-queue.js";
import {
  VOICE_BACKEND_SYSTEM_PROMPT,
  VOICE_ORCHESTRATOR_SYSTEM_PROMPT,
  buildCallStartPrompt,
  buildFleetBlock,
  buildDelegationPrompt,
  buildNoticePrompt,
  buildNarrationPrompt,
  clipForSpeech,
  type VoiceFleetEntry,
} from "./prompt.js";
import { isSpokenApproval } from "./spoken-approval.js";

export const VOICE_ORCHESTRATOR_LABEL = "paseo.voice";
const STATE_FILENAME = "orchestrator.json";
const FLEET_LIMIT = 12;
const FLEET_RECENT_MS = 12 * 60 * 60 * 1000;
const SESSION_INDEX_LIMIT = 30;
const SESSION_INDEX_RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const APPROVAL_WINDOW_MS = 90_000;
const PROGRESS_CHECK_MS = 45_000;
const PROGRESS_MIN_INTERVAL_MS = 120_000;
const DELEGATION_MAX_WAITS = 6;
const FLEET_CHANGED_DEBOUNCE_MS = 500;
// A mode switch hands the conversation over within seconds; older history belongs to a past call.
const HANDOFF_HISTORY_MS = 90_000;

const OrchestratorStateSchema = z.object({ agentId: z.guid() });

export interface GptLiveEngineConfig {
  apiKey: string;
  model: string;
  voice: string;
}

export interface VoiceOrchestratorCall {
  isUserSpeaking(): boolean;
  /** Speaks notice lines directly. Without it, notices go through the orchestrator agent. */
  announce?(lines: string[]): void;
  /** Called (debounced) whenever an agent's state changes during the call. */
  onFleetChanged?(): void;
}

export interface VoiceOrchestratorOptions {
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: WorkspaceRegistry | null;
  provider?: AgentProvider | null;
  model?: string | null;
  thinking?: string | null;
  language?: string | null;
  live?: GptLiveEngineConfig | null;
  /** Speech providers for messages mode; without them the phone transcribes and speaks itself. */
  speech?: VoiceMessagesSpeech | null;
  logger: pino.Logger;
}

/**
 * Owns the daemon's single voice orchestrator agent: an internal agent that drives
 * the other agents through the Paseo tools during a global voice call, and the
 * queue of agent events it announces while a call is attached.
 */
export class VoiceOrchestrator {
  readonly messages: VoiceMessagesHub;
  private readonly logger: pino.Logger;
  private agentIdPromise: Promise<string> | null = null;
  private knownAgentId: string | null = null;
  private ensurePromise: Promise<string> | null = null;
  private call: VoiceOrchestratorCall | null = null;
  private queue: VoiceNoticeQueue | null = null;
  private unsubscribeSelf: (() => void) | null = null;
  private unsubscribeFleet: (() => void) | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lifecycles = new Map<string, string>();
  private readonly progressAnnounced = new Map<string, { step: string; at: number }>();
  private fleetChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUtterance: { text: string; at: number; approvalUsed: boolean } | null = null;
  private preferredLanguage: string | null = null;
  private turnChain: Promise<unknown> = Promise.resolve();
  private liveCall: { close(): void } | null = null;
  private handoffHistory: { lines: string[]; at: number; mode: "live" | "messages" } | null = null;

  constructor(private readonly options: VoiceOrchestratorOptions) {
    this.logger = options.logger.child({ module: "voice-orchestrator" });
    this.messages = new VoiceMessagesHub({
      orchestrator: this,
      speech: options.speech ?? { resolveStt: () => null, resolveTts: () => null },
      logger: this.logger,
    });
    void this.resolveAgentId().catch((error) => {
      this.agentIdPromise = null;
      this.logger.warn({ err: error }, "Failed to load voice orchestrator id");
    });
  }

  get liveEngine(): GptLiveEngineConfig | null {
    return this.options.live ?? null;
  }

  /** The host's configured voice language wins over the app's UI language. */
  get language(): string | null {
    return this.options.language ?? this.preferredLanguage;
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
    this.queue = new VoiceNoticeQueue({
      batchWindowMs: 4_000,
      urgentDelayMs: 750,
      busyRetryMs: 1_000,
      isBusy: () => this.isBusy(),
      isStale: (notice) => this.isNoticeStale(notice),
      deliver: (notices) => this.deliverNotices(notices),
    });
    this.watchFleet();
    if (!call.announce) void this.sendCallStart(call);
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

  /** Sends the user's spoken words to the orchestrator with a fresh fleet snapshot. */
  async sendSpokenRequest(text: string): Promise<void> {
    const agentId = await this.ensureAgent();
    const [fleet, others] = await Promise.all([
      this.describeFleetDetailed(),
      this.describeOtherSessions(),
    ]);
    await this.sendPrompt(
      agentId,
      `${buildFleetBlock(fleet, others)}\n${wrapSpokenInput(text)}`,
      true,
    );
  }

  registerLiveCall(call: { close(): void }): () => void {
    this.liveCall = call;
    return () => {
      if (this.liveCall === call) this.liveCall = null;
    };
  }

  /** Messages mode replaces a live call; GPT-Live bills per minute while its session is open. */
  closeLiveCall(): void {
    const call = this.liveCall;
    this.liveCall = null;
    call?.close();
  }

  saveCallHistory(lines: string[], mode: "live" | "messages"): void {
    this.handoffHistory = lines.length > 0 ? { lines: [...lines], at: Date.now(), mode } : null;
  }

  /** The conversation of a call in the other mode that just ended: the call is switching modes. */
  takeRecentHistory(fromMode: "live" | "messages"): string[] {
    const handoff = this.handoffHistory;
    if (!handoff || handoff.mode !== fromMode) return [];
    this.handoffHistory = null;
    if (Date.now() - handoff.at > HANDOFF_HISTORY_MS) return [];
    return handoff.lines;
  }

  callerContext(): VoiceCallerContext {
    return {
      childAgentDefaultLabels: {},
      allowCustomCwd: true,
      authorizePermissionApproval: () => this.authorizePermissionApproval(),
    };
  }

  /** Runs one delegated voice request on the orchestrator agent and returns its reply. */
  async runDelegation(params: { request: string; history: string[] }): Promise<string> {
    if (params.request.trim()) this.noteUserUtterance(params.request);
    return this.runTurn(async () => {
      const [fleet, others] = await Promise.all([
        this.describeFleetDetailed(),
        this.describeOtherSessions(),
      ]);
      return buildDelegationPrompt({ ...params, fleet, others });
    }, true);
  }

  /** Has the orchestrator turn daemon updates (or the call start) into a short spoken text. */
  async narrate(params: {
    kind: "notices" | "call_start";
    lines: string[];
    history: string[];
  }): Promise<string> {
    return this.runTurn(async () => {
      const fleet = params.kind === "call_start" ? await this.describeFleet() : [];
      return buildNarrationPrompt({ ...params, fleet, language: this.language });
    }, false);
  }

  /** One agent turn at a time: delegations and narrations would otherwise interrupt each other. */
  private runTurn(buildPrompt: () => Promise<string>, fromUser: boolean): Promise<string> {
    const run = async (): Promise<string> => {
      const agentId = await this.ensureAgent();
      await this.sendPrompt(agentId, await buildPrompt(), fromUser);
      const { agentManager } = this.options;
      let result = await agentManager.waitForAgentEvent(agentId, { waitForActive: true });
      for (let attempt = 0; result.permission && attempt < DELEGATION_MAX_WAITS; attempt += 1) {
        result = await agentManager.waitForAgentEvent(agentId);
      }
      return result.lastMessage?.trim() || "No result from the backend.";
    };
    const turn = this.turnChain.then(run, run);
    this.turnChain = turn.catch(() => undefined);
    return turn;
  }

  async describeFleet(): Promise<VoiceFleetEntry[]> {
    return Promise.all(
      this.listFleetAgents().map(async (agent) => ({
        workspace: await this.describeWorkspace(agent),
        title: agent.config.title?.trim() || "Untitled agent",
        status: this.describeStatus(agent),
      })),
    );
  }

  /** One line per relevant agent with everything a status answer needs, so no tool call is required. */
  async describeFleetDetailed(): Promise<string[]> {
    const { agentManager } = this.options;
    return Promise.all(
      this.listFleetAgents().map(async (agent) => {
        const work = agentManager.getLiveWorkSummary(agent.id);
        const last = await agentManager.getLastAssistantMessage(agent.id).catch(() => null);
        const permission = [...agent.pendingPermissions.values()].at(-1);
        const parts = [
          `- ${await this.describeWorkspace(agent)} · "${agent.config.title?.trim() || "Untitled agent"}" (id ${agent.id}, ${agent.provider})`,
          `status: ${this.describeStatus(agent)}`,
          work.request ? `task: ${clipForSpeech(work.request, 240)}` : null,
          permission
            ? `pending permission: ${clipForSpeech([permission.title ?? permission.name, permission.description].filter(Boolean).join(": "), 200)}`
            : null,
          last ? `last message: ${clipForSpeech(last, 400)}` : null,
        ];
        return parts.filter((part): part is string => part !== null).join(" | ");
      }),
    );
  }

  /**
   * Compact index of other open (not archived) sessions, including ones not loaded in memory,
   * so the user can name an older session or its workspace and the assistant can find it.
   */
  async describeOtherSessions(): Promise<string[]> {
    const shown = new Set(this.listFleetAgents().map((agent) => agent.id));
    const now = Date.now();
    const records = (await this.options.agentStorage.list().catch(() => []))
      .filter(
        (record) =>
          !record.internal &&
          !record.archivedAt &&
          !shown.has(record.id) &&
          !this.isOrchestrator(record.id) &&
          now - Date.parse(record.lastActivityAt ?? record.updatedAt) < SESSION_INDEX_RECENT_MS,
      )
      .sort(
        (left, right) =>
          Date.parse(right.lastActivityAt ?? right.updatedAt) -
          Date.parse(left.lastActivityAt ?? left.updatedAt),
      )
      .slice(0, SESSION_INDEX_LIMIT);
    return Promise.all(
      records.map(async (record) => {
        const workspace = await this.describeWorkspaceById(record.workspaceId, record.cwd);
        const title = clipForSpeech(record.title?.trim() || "Untitled agent", 80);
        const lastActive = (record.lastActivityAt ?? record.updatedAt).slice(0, 10);
        return `- ${workspace} · "${title}" (id ${record.id}, idle since ${lastActive})`;
      }),
    );
  }

  private listFleetAgents(): ManagedAgent[] {
    const now = Date.now();
    return this.options.agentManager
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
  }

  dispose(): void {
    this.messages.dispose();
    this.detachCurrentCall();
  }

  private detachCurrentCall(): void {
    this.queue?.close();
    this.queue = null;
    this.call = null;
    this.lastUtterance = null;
    this.unsubscribeFleet?.();
    this.unsubscribeFleet = null;
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
    if (this.fleetChangedTimer) clearTimeout(this.fleetChangedTimer);
    this.fleetChangedTimer = null;
    this.lifecycles.clear();
    this.progressAnnounced.clear();
  }

  private watchFleet(): void {
    const { agentManager } = this.options;
    for (const agent of agentManager.listAgents()) this.lifecycles.set(agent.id, agent.lifecycle);
    this.unsubscribeFleet = agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") return;
        const agent = event.agent;
        if (!this.isOrchestrator(agent.id)) this.scheduleFleetChanged();
        const previous = this.lifecycles.get(agent.id);
        this.lifecycles.set(agent.id, agent.lifecycle);
        if (
          agent.lifecycle === "running" &&
          previous !== "running" &&
          previous !== "initializing" &&
          !this.isOrchestrator(agent.id) &&
          !isDelegatedAgent(agent) &&
          !this.isOrchestratorRunning()
        ) {
          this.queue?.push({ agentId: agent.id, reason: "started" });
        }
      },
      { replayState: false },
    );
    this.progressTimer = setInterval(() => this.checkProgress(), PROGRESS_CHECK_MS);
    this.progressTimer.unref?.();
  }

  private scheduleFleetChanged(): void {
    const call = this.call;
    if (!call?.onFleetChanged || this.fleetChangedTimer) return;
    this.fleetChangedTimer = setTimeout(() => {
      this.fleetChangedTimer = null;
      if (this.call === call) call.onFleetChanged?.();
    }, FLEET_CHANGED_DEBOUNCE_MS);
  }

  private checkProgress(): void {
    const now = Date.now();
    for (const agent of this.options.agentManager.listAgents()) {
      if (
        agent.lifecycle !== "running" ||
        this.isOrchestrator(agent.id) ||
        isDelegatedAgent(agent)
      ) {
        continue;
      }
      const step = this.options.agentManager.getLiveWorkSummary(agent.id).currentStep;
      if (!step) continue;
      const last = this.progressAnnounced.get(agent.id);
      if (last && (last.step === step || now - last.at < PROGRESS_MIN_INTERVAL_MS)) continue;
      this.progressAnnounced.set(agent.id, { step, at: now });
      this.queue?.push({ agentId: agent.id, reason: "progress" });
    }
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
    const model = this.options.model ?? (provider === "claude" ? "haiku" : undefined);
    this.logger.info({ agentId, provider, model }, "Creating voice orchestrator agent");
    await this.options.agentManager.createAgent(
      {
        provider,
        cwd,
        ...(model ? { model } : {}),
        ...(this.options.thinking ? { thinkingOptionId: this.options.thinking } : {}),
        title: "Voice",
        systemPrompt: this.options.live
          ? VOICE_BACKEND_SYSTEM_PROMPT
          : buildVoiceModeSystemPrompt(VOICE_ORCHESTRATOR_SYSTEM_PROMPT, true),
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

  private isOrchestratorRunning(): boolean {
    const agentId = this.knownAgentId;
    const agent = agentId ? this.options.agentManager.getAgent(agentId) : null;
    return agent?.lifecycle === "running" || agent?.lifecycle === "initializing";
  }

  private isBusy(): boolean {
    if (this.call?.isUserSpeaking()) return true;
    return !this.call?.announce && this.isOrchestratorRunning();
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
      case "started":
      case "progress":
        return agent.lifecycle !== "running";
    }
  }

  private async sendCallStart(call: VoiceOrchestratorCall): Promise<void> {
    try {
      const agentId = await this.ensureAgent();
      const fleet = await this.describeFleet();
      if (this.call !== call) return;
      await this.sendPrompt(agentId, buildCallStartPrompt({ fleet, language: this.language }));
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
    if (lines.length === 0) return;
    if (this.call?.announce) {
      this.call.announce(lines);
      return;
    }
    if (!this.knownAgentId) return;
    try {
      await this.sendPrompt(this.knownAgentId, buildNoticePrompt(lines));
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to deliver voice notices");
    }
  }

  private async sendPrompt(agentId: string, text: string, fromUser = false): Promise<void> {
    await sendPromptToAgent({
      agentManager: this.options.agentManager,
      agentStorage: this.options.agentStorage,
      agentId,
      prompt: text,
      unarchive: false,
      clearPendingPermissions: fromUser,
      logger: this.logger,
    });
  }

  private async describeNotice(notice: VoiceNotice): Promise<string | null> {
    const { agentManager } = this.options;
    const agent = agentManager.getAgent(notice.agentId);
    if (!agent) return null;
    const name = await this.describeAgentName(agent);
    const work = agentManager.getLiveWorkSummary(agent.id);
    const task = work.request ? ` Its task: ${clipForSpeech(work.request, 200)}` : "";
    switch (notice.reason) {
      case "permission": {
        const request = [...agent.pendingPermissions.values()].at(-1);
        if (!request) return null;
        const what = clipForSpeech(
          [request.title ?? request.name, request.description].filter(Boolean).join(": "),
          240,
        );
        return `${name} is waiting for permission: ${what}.${task}`;
      }
      case "error":
        return `${name} failed: ${clipForSpeech(agent.lastError ?? "unknown error", 240)}.${task}`;
      case "finished": {
        const message = await agentManager.getLastAssistantMessage(agent.id).catch(() => null);
        const result = message ? ` Its final message: ${clipForSpeech(message, 700)}` : "";
        return `${name} finished.${task}${result}`;
      }
      case "started":
        return `${name} started working.${task}`;
      case "progress":
        return work.currentStep ? `${name} is now: ${clipForSpeech(work.currentStep, 160)}.` : null;
    }
  }

  private describeStatus(agent: ManagedAgent): string {
    if (agent.pendingPermissions.size > 0) return "waiting for permission";
    if (agent.lifecycle === "error") return "failed";
    if (agent.lifecycle === "running") {
      const work = this.options.agentManager.getLiveWorkSummary(agent.id);
      const detail = work.currentStep ?? work.request;
      return detail ? `working on: ${clipForSpeech(detail, 140)}` : "working";
    }
    if (agent.attention.requiresAttention && agent.attention.attentionReason === "finished") {
      return "finished, not reviewed yet";
    }
    return "idle";
  }

  private async describeAgentName(agent: ManagedAgent): Promise<string> {
    const title = agent.config.title?.trim() || "an agent";
    return `${await this.describeWorkspace(agent)} · ${title}`;
  }

  private async describeWorkspace(agent: ManagedAgent): Promise<string> {
    return this.describeWorkspaceById(agent.workspaceId, agent.cwd);
  }

  private async describeWorkspaceById(
    workspaceId: string | undefined,
    cwd: string,
  ): Promise<string> {
    if (workspaceId && this.options.workspaceRegistry) {
      const record = await this.options.workspaceRegistry.get(workspaceId).catch(() => null);
      if (record) return record.title ?? record.displayName;
    }
    return basename(cwd);
  }
}

function fleetRank(agent: ManagedAgent): number {
  if (agent.pendingPermissions.size > 0) return 0;
  if (agent.lifecycle === "error") return 1;
  if (agent.attention.requiresAttention) return 2;
  if (agent.lifecycle === "running") return 3;
  return 4;
}
