import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
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
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import type {
  VoiceFleetDigest,
  VoiceFleetHostState,
  VoiceToolResult,
} from "@getpaseo/protocol/voice-fleet/types";
import type { PaseoToolCatalog } from "../agent/tools/types.js";
import { FastLlmClient, type FastLlmConfig } from "./fast-brain/llm-client.js";
import { VoiceRouter, type RoutePlan, type RouteResult } from "./fast-brain/router.js";
import { VoiceToolbox, type VoiceAgentDefaults } from "./fast-brain/voice-toolbox.js";
import { DigestSummarizer } from "./digest/digest-summarizer.js";
import { LocalFleet } from "./fleet/local-fleet.js";
import { RemoteFleet, type CourierChannel } from "./fleet/remote-fleet.js";
import { FleetView } from "./fleet/fleet-view.js";
import { speakableClip } from "./speakable.js";
import type { VoiceMessagesSpeech } from "./messages/messages-call.js";
import { VoiceMessagesHub } from "./messages/messages-hub.js";
import { LiveWebrtcHub } from "./gpt-live/webrtc-hub.js";
import { CallTranscript } from "./call-transcript.js";
import { VoiceNoticeQueue, type VoiceNotice, type VoiceNoticeReason } from "./notice-queue.js";
import { UnheardLedger, isUnheardReason } from "./unheard-ledger.js";
import {
  VOICE_BACKEND_SYSTEM_PROMPT,
  VOICE_ORCHESTRATOR_SYSTEM_PROMPT,
  buildCallStartPrompt,
  buildFleetBlock,
  buildDelegationPrompt,
  buildNoticePrompt,
  buildNarrationPrompt,
  clipAgentMessage,
  clipForSpeech,
  type VoiceFleetEntry,
} from "./prompt.js";
import { isSpokenApproval } from "./spoken-approval.js";
import { describePermission } from "./digest/agent-digest.js";

export const VOICE_ORCHESTRATOR_LABEL = "paseo.voice";
const STATE_FILENAME = "orchestrator.json";
const UNHEARD_FILENAME = "unheard.json";
const UNHEARD_TTL_MS = 12 * 60 * 60 * 1000;
// Announcing an unheard result again after an interruption; past this it waits for the next call.
const UNHEARD_MAX_REPEATS = 2;
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
// A notice waits this long for a model summary before it falls back to the agent's own words.
const NOTICE_SUMMARY_WAIT_MS = 2_500;
const PHONE_SYNC_GAP_MS = 12_000;
const CALL_STARTING_MS = 30_000;

const OrchestratorStateSchema = z.object({ agentId: z.guid() });

export interface GptLiveEngineConfig {
  apiKey: string;
  model: string;
  voice: string;
}

export interface VoiceOrchestratorCall {
  isUserSpeaking(): boolean;
  /** Updates wait while the assistant is still talking instead of cutting it off. */
  isAssistantSpeaking?(): boolean;
  /**
   * Speaks notice lines directly. Without it, notices go through the orchestrator agent.
   * `urgent` (permissions, failures) may take the next short pause; the rest wait for a lull.
   * `onOutcome` reports whether the user heard it through or cut it off.
   */
  announce?(
    lines: string[],
    options?: { urgent: boolean; onOutcome?: (heard: boolean) => void },
  ): void;
  /** Called (debounced) whenever an agent's state changes during the call. */
  onFleetChanged?(): void;
  /** Records a call event (phone liveness, app state) in the call's transcript. */
  noteEvent?(text: string, detail: Record<string, unknown>): void;
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
  projectRegistry?: ProjectRegistry | null;
  /** The fast model that turns requests into tool calls; without it the llm agent does. */
  router?: FastLlmConfig | null;
  /** Paseo tools acting for the user with no calling agent. */
  createToolCatalog?: (context: VoiceCallerContext) => Promise<PaseoToolCatalog>;
  hostMetrics?: (() => Promise<HostMetricsSnapshot>) | null;
  logger: pino.Logger;
}

/**
 * Owns the daemon's single voice orchestrator agent: an internal agent that drives
 * the other agents through the Paseo tools during a global voice call, and the
 * queue of agent events it announces while a call is attached.
 */
export class VoiceOrchestrator {
  readonly messages: VoiceMessagesHub;
  readonly webrtc: LiveWebrtcHub;
  private readonly logger: pino.Logger;
  private agentIdPromise: Promise<string> | null = null;
  private knownAgentId: string | null = null;
  private ensurePromise: Promise<string> | null = null;
  private call: VoiceOrchestratorCall | null = null;
  private queue: VoiceNoticeQueue | null = null;
  private unsubscribeSelf: (() => void) | null = null;
  private unsubscribeAgents: (() => void) | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lifecycles = new Map<string, string>();
  private readonly progressAnnounced = new Map<string, { step: string; at: number }>();
  private fleetChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUtterance: { text: string; at: number; approvalUsed: boolean } | null = null;
  private preferredLanguage: string | null = null;
  private turnChain: Promise<unknown> = Promise.resolve();
  private narrating = false;
  private liveCall: { close(): void; setInputMuted(muted: boolean): void } | null = null;
  private handoffHistory: { lines: string[]; at: number; mode: "live" | "messages" } | null = null;
  private readonly unheard: UnheardLedger;
  private readonly unheardLoaded: Promise<void>;
  /** Agents the user asked about by voice; their results are kept for the next call. */
  private readonly followed = new Set<string>();
  private agentModes: Record<string, string> = {};
  private agentDefaults: VoiceAgentDefaults = {};
  private spokenRequests = 0;
  private readonly llm: FastLlmClient | null;
  private readonly summarizer: DigestSummarizer | null;
  readonly localFleet: LocalFleet;
  readonly remoteFleet: RemoteFleet;
  private readonly toolbox: VoiceToolbox | null;
  private toolCatalog: Promise<PaseoToolCatalog> | null = null;
  /** One per call: it holds the call's pending confirmation. */
  private router: VoiceRouter | null = null;
  private selfLabel: string = describeHostname(hostname());
  private lastPhoneSyncAt = 0;
  private callStartingAt = 0;
  private lastPhoneAppState: string | null = null;

  constructor(private readonly options: VoiceOrchestratorOptions) {
    this.logger = options.logger.child({ module: "voice-orchestrator" });
    this.messages = new VoiceMessagesHub({
      orchestrator: this,
      speech: options.speech ?? { resolveStt: () => null, resolveTts: () => null },
      logger: this.logger,
    });
    this.webrtc = new LiveWebrtcHub({ orchestrator: this, logger: this.logger });
    this.llm = options.router ? new FastLlmClient(options.router, this.logger) : null;
    this.summarizer = this.llm
      ? new DigestSummarizer({ llm: this.llm, language: () => this.language, logger: this.logger })
      : null;
    this.localFleet = new LocalFleet({
      agentManager: options.agentManager,
      agentStorage: options.agentStorage,
      workspaceRegistry: options.workspaceRegistry,
      projectRegistry: options.projectRegistry ?? null,
      isHidden: (agentId) => this.isOrchestrator(agentId),
      isUnheard: (agentId) => this.unheard.has(agentId),
      summarizer: this.summarizer,
      hostMetrics: options.hostMetrics ?? null,
      logger: this.logger,
    });
    this.remoteFleet = new RemoteFleet({
      logger: this.logger,
      onChange: () => this.scheduleFleetChanged(),
    });
    const createToolCatalog = options.createToolCatalog;
    this.toolbox = createToolCatalog
      ? new VoiceToolbox({
          catalog: () => {
            this.toolCatalog ??= createToolCatalog(this.voiceToolsContext());
            return this.toolCatalog;
          },
          agentManager: options.agentManager,
          agentStorage: options.agentStorage,
          hostMetrics: options.hostMetrics ?? null,
          hostLabel: () => this.selfLabel,
          defaults: () => this.agentDefaults,
          logger: this.logger,
        })
      : null;
    this.unheard = new UnheardLedger({
      path: join(this.orchestratorDir(), UNHEARD_FILENAME),
      ttlMs: UNHEARD_TTL_MS,
      logger: this.logger,
    });
    this.unheardLoaded = this.unheard.load().catch((error: unknown) => {
      this.logger.warn({ err: error }, "Failed to load unheard voice results");
    });
    this.watchAgents();
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

  setPreferredAgentModes(modes: Record<string, string> | undefined): void {
    if (modes) this.agentModes = { ...modes };
  }

  setPreferredAgentDefaults(defaults: VoiceAgentDefaults | undefined): void {
    if (defaults) this.agentDefaults = { ...defaults };
  }

  /** Whether requests skip the llm agent: a fast model picks tools and the host runs them. */
  get hasFastBrain(): boolean {
    return this.llm !== null && this.toolbox !== null;
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
      await this.refreshSystemPrompt(existing);
      return agentId;
    }
    this.ensurePromise ??= this.createAgent(agentId).finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  /** A call is connecting here; the phone's fleet reports are kept for it. */
  noteCallStarting(): void {
    this.callStartingAt = Date.now();
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
      isStale: (notice) => this.dropIfStale(notice),
      deliver: (notices) => this.deliverNotices(notices),
    });
    this.progressTimer = setInterval(() => this.checkProgress(), PROGRESS_CHECK_MS);
    this.progressTimer.unref?.();
    if (this.llm && this.toolbox) {
      this.router = new VoiceRouter({
        llm: this.llm,
        executor: {
          execute: (params) => this.executeTool(params),
          escalate: (request) => this.escalate(request),
        },
        logger: this.logger,
      });
      this.llm.keepWarm(true);
    }
    this.summarizer?.setWatching(true);
    this.localFleet.refreshHealth();
    void this.replayUnheard(this.queue);
    if (!call.announce) void this.sendCallStart(call);
    return () => {
      if (this.call !== call) return;
      this.detachCurrentCall();
    };
  }

  handleAttention(params: { agentId: string; reason: VoiceNoticeReason }): void {
    if (this.isOrchestrator(params.agentId)) return;
    this.noteNotice({ agentId: params.agentId, reason: params.reason });
  }

  noteUserUtterance(text: string): void {
    this.lastUtterance = { text, at: Date.now(), approvalUsed: false };
  }

  /** Returns a refusal message unless the user's latest words approve a single permission. */
  authorizePermissionApproval(): string | null {
    const utterance = this.lastUtterance;
    if (
      this.narrating ||
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
    this.spokenRequests += 1;
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

  registerLiveCall(call: { close(): void; setInputMuted(muted: boolean): void }): () => void {
    this.liveCall = call;
    return () => {
      if (this.liveCall === call) this.liveCall = null;
    };
  }

  /** GPT-Live's own input mute; the phone also keeps streaming silence so the session runs. */
  setCallMuted(muted: boolean): void {
    this.liveCall?.setInputMuted(muted);
  }

  /** Every call is recorded under $PASEO_HOME/voice/calls so it can be read back later. */
  openTranscript(params: { callId: string; mode: string }): CallTranscript {
    return new CallTranscript({
      directory: join(this.orchestratorDir(), "calls"),
      callId: params.callId,
      mode: params.mode,
      logger: this.logger,
    });
  }

  /** Messages mode replaces a live call; GPT-Live bills per minute while its session is open. */
  closeLiveCall(): void {
    const call = this.liveCall;
    this.liveCall = null;
    call?.close();
  }

  /** An answer that finished after its live call closed goes to the messages call instead. */
  deliverLateReply(text: string): void {
    this.messages.deliverLateReply(text);
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
      actsForUser: true,
      authorizePermissionApproval: () => this.authorizePermissionApproval(),
      defaultModeFor: (provider) => this.agentModes[provider],
      onAgentPrompted: (agentId) => this.followed.add(agentId),
    };
  }

  /**
   * Runs one delegated voice request and returns what to say. With a fast brain a small model
   * picks tools that run on the host; otherwise the orchestrator agent takes a turn.
   */
  async runDelegation(params: {
    request: string;
    history: string[];
    plan?: RoutePlan | null;
    audience?: "voice-model" | "speech";
    onTimings?: (result: RouteResult) => void;
  }): Promise<string> {
    if (params.request.trim()) this.noteUserUtterance(params.request);
    const router = this.router;
    if (router) {
      try {
        const result = await router.route(
          {
            latest: params.request,
            conversation: params.history,
            view: params.plan?.view ?? (await this.fleetView()),
            language: this.language,
            audience: params.audience ?? "voice-model",
          },
          params.plan,
        );
        params.onTimings?.(result);
        return result.text;
      } catch (error) {
        this.logger.warn({ err: error }, "Fast voice router failed; using the voice agent");
      }
    }
    return this.runTurn(async () => {
      const [fleet, others] = await Promise.all([
        this.describeFleetDetailed(),
        this.describeOtherSessions(),
      ]);
      return buildDelegationPrompt({ ...params, fleet, others });
    }, true);
  }

  /**
   * Starts the router's model call while the user is still finishing: it only plans, so it is
   * safe to throw away. `runDelegation` uses it when the request turns out the same.
   */
  async planDelegation(params: { request: string; history: string[] }): Promise<RoutePlan | null> {
    const router = this.router;
    if (!router || !params.request.trim() || router.hasPendingConfirmation) return null;
    return router.plan({
      latest: params.request,
      conversation: params.history,
      view: await this.fleetView(),
      language: this.language,
      audience: "voice-model",
    });
  }

  /** Has the orchestrator turn daemon updates (or the call start) into a short spoken text. */
  async narrate(params: {
    kind: "notices" | "call_start";
    lines: string[];
    history: string[];
  }): Promise<string> {
    if (this.llm) {
      try {
        const fleet = params.kind === "call_start" ? await this.describeFleet() : [];
        const completion = await this.llm.complete({
          messages: [
            {
              role: "user",
              content: buildNarrationPrompt({ ...params, fleet, language: this.language }),
            },
          ],
          maxTokens: 220,
          temperature: 0.4,
        });
        const text = completion.content?.trim();
        if (text) return text;
      } catch (error) {
        this.logger.warn({ err: error }, "Fast narration failed; using the voice agent");
      }
    }
    return this.runTurn(async () => {
      const fleet = params.kind === "call_start" ? await this.describeFleet() : [];
      return buildNarrationPrompt({ ...params, fleet, language: this.language });
    }, false);
  }

  /** Every host the call can see: this one, plus the others as the phone last reported them. */
  async fleetView(): Promise<FleetView> {
    const local = await this.localFleet.digest();
    return new FleetView([
      {
        serverId: null,
        label: this.selfLabel,
        online: true,
        lastSeenAt: null,
        supportsTools: true,
        digest: local,
      },
      ...this.remoteFleet.fleetHosts(),
    ]);
  }

  /** This host's fleet for a call running on another host; asking counts as watching. */
  async fleetDigest(): Promise<VoiceFleetDigest> {
    this.summarizer?.observe(90_000);
    this.localFleet.refreshHealth();
    return this.localFleet.digest();
  }

  /** A voice tool that a call on another host sent here through the phone. */
  async invokeTool(params: {
    operationId: string;
    tool: string;
    args: Record<string, unknown>;
  }): Promise<VoiceToolResult> {
    if (!this.toolbox) throw new Error("Voice tools are not available on this host.");
    return this.toolbox.execute(params);
  }

  /** The phone's report of the other hosts; the phone is also this call's courier. */
  updateRemoteFleet(params: {
    hosts: VoiceFleetHostState[];
    appState: string | null;
    selfLabel: string | null;
    channel: CourierChannel | null;
  }): boolean {
    const call = this.call;
    // The phone starts syncing while the call is still connecting; keep what it sends.
    const starting = Date.now() - this.callStartingAt < CALL_STARTING_MS;
    if (!call && !starting) return false;
    if (params.selfLabel?.trim()) this.selfLabel = params.selfLabel.trim();
    if (!call) {
      this.remoteFleet.update(params);
      return true;
    }
    const now = Date.now();
    const gapMs = this.lastPhoneSyncAt > 0 ? now - this.lastPhoneSyncAt : 0;
    // Syncs come every 5 s; a long gap means the phone's JS was suspended (screen locked).
    if (gapMs > PHONE_SYNC_GAP_MS) {
      this.logger.warn({ gapMs, appState: params.appState }, "Voice call phone went silent");
      call.noteEvent?.("phone_silent", { gapMs, appState: params.appState });
    }
    if (params.appState !== this.lastPhoneAppState) {
      call.noteEvent?.("phone_app_state", { appState: params.appState });
      this.lastPhoneAppState = params.appState;
    }
    this.lastPhoneSyncAt = now;
    this.remoteFleet.update(params);
    return true;
  }

  settleCourier(params: {
    operationId: string;
    result: VoiceToolResult | null;
    error: string | null;
  }): void {
    this.remoteFleet.settle(params);
  }

  private async executeTool(params: {
    host: { serverId: string | null; label: string };
    tool: string;
    args: Record<string, unknown>;
    operationId: string;
  }): Promise<VoiceToolResult> {
    if (params.host.serverId === null) {
      if (!this.toolbox) throw new Error("Voice tools are not available on this host.");
      return this.toolbox.execute(params);
    }
    return this.remoteFleet.run(
      {
        operationId: params.operationId,
        serverId: params.host.serverId,
        tool: params.tool,
        args:
          params.tool === "start_agent" || params.tool === "create_workspace"
            ? this.withAgentDefaults(params.args)
            : params.args,
        language: this.language,
      },
      params.host.label,
    );
  }

  /** Another host has no app preferences; the call brings the user's choices along. */
  private withAgentDefaults(args: Record<string, unknown>): Record<string, unknown> {
    return { ...args, defaults: this.agentDefaults };
  }

  /** Long work goes to the full voice agent in the background; its result is announced. */
  private async escalate(request: string): Promise<string> {
    const call = this.call;
    void (async () => {
      try {
        const result = await this.runTurn(async () => {
          const [fleet, others] = await Promise.all([
            this.describeFleetDetailed(),
            this.describeOtherSessions(),
          ]);
          return buildDelegationPrompt({ request, history: [], fleet, others });
        }, true);
        const text = speakableClip(result, 900);
        if (this.call && this.call === call && call.announce) {
          call.announce(
            [`Result of the background request "${speakableClip(request, 120)}": ${text}`],
            {
              urgent: true,
            },
          );
        } else {
          this.deliverLateReply(text);
        }
      } catch (error) {
        this.logger.warn({ err: error }, "Escalated voice request failed");
        call?.announce?.([`The background request "${speakableClip(request, 120)}" failed.`], {
          urgent: true,
        });
      }
    })();
    return "Handed to the full assistant, which works on it in the background; Paseo tells the user the result when it's done.";
  }

  private voiceToolsContext(): VoiceCallerContext {
    return {
      childAgentDefaultLabels: {},
      allowCustomCwd: true,
      actsForUser: true,
      defaultModeFor: (provider) => this.agentModes[provider],
      onAgentPrompted: (agentId) => this.followed.add(agentId),
    };
  }

  /** One agent turn at a time: delegations and narrations would otherwise interrupt each other. */
  private runTurn(buildPrompt: () => Promise<string>, fromUser: boolean): Promise<string> {
    const run = async (): Promise<string> => {
      // Narration turns relay daemon updates; they never act on the user's last "yes".
      this.narrating = !fromUser;
      try {
        const agentId = await this.ensureAgent();
        await this.sendPrompt(agentId, await buildPrompt(), fromUser);
        const { agentManager } = this.options;
        let result = await agentManager.waitForAgentEvent(agentId, { waitForActive: true });
        for (let attempt = 0; result.permission && attempt < DELEGATION_MAX_WAITS; attempt += 1) {
          result = await agentManager.waitForAgentEvent(agentId);
        }
        return result.lastMessage?.trim() || "No result from the backend.";
      } finally {
        this.narrating = false;
      }
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
        const digest = this.localFleet.digestAgent(agent);
        const parts = [
          `- ${await this.describeWorkspace(agent)} · "${agent.config.title?.trim() || "Untitled agent"}" (id ${agent.id}, ${agent.provider})`,
          `status: ${this.describeStatus(agent)}`,
          digest.summary ? `summary: ${digest.summary}` : null,
          digest.now ? `now: ${digest.now}` : null,
          digest.progress ?? null,
          digest.activity ? `so far: ${digest.activity}` : null,
          work.request ? `task: ${clipForSpeech(work.request, 240)}` : null,
          permission
            ? `pending permission: ${clipForSpeech([permission.title ?? permission.name, permission.description].filter(Boolean).join(": "), 200)}`
            : null,
          last ? `last message: ${clipAgentMessage(last, 400, agent.id)}` : null,
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
    this.webrtc.endAll();
    this.detachCurrentCall();
    this.unsubscribeAgents?.();
    this.unsubscribeAgents = null;
  }

  private detachCurrentCall(): void {
    const hadCall = this.call !== null;
    this.queue?.close();
    this.queue = null;
    this.call = null;
    this.router = null;
    this.lastPhoneSyncAt = 0;
    this.lastPhoneAppState = null;
    this.llm?.keepWarm(false);
    this.summarizer?.setWatching(false);
    // Only a call that ends forgets the fleet; a new call may already have the phone's report.
    if (hadCall) this.remoteFleet.reset();
    this.lastUtterance = null;
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
    if (this.fleetChangedTimer) clearTimeout(this.fleetChangedTimer);
    this.fleetChangedTimer = null;
    this.progressAnnounced.clear();
  }

  /** Watches every agent for the whole daemon life, so results landing between calls are kept. */
  private watchAgents(): void {
    const { agentManager } = this.options;
    for (const agent of agentManager.listAgents()) this.lifecycles.set(agent.id, agent.lifecycle);
    this.unsubscribeAgents = agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") return;
        const agent = event.agent;
        const previous = this.lifecycles.get(agent.id);
        this.lifecycles.set(agent.id, agent.lifecycle);
        if (this.isOrchestrator(agent.id)) return;
        this.scheduleFleetChanged();
        if (isDelegatedAgent(agent)) return;
        // The run ending is the signal, not attention: attention stays raised for an unreviewed
        // earlier finish and never fires again for the next one.
        if (previous === "running" && (agent.lifecycle === "idle" || agent.lifecycle === "error")) {
          this.noteNotice({
            agentId: agent.id,
            reason: agent.lifecycle === "error" ? "error" : "finished",
          });
          return;
        }
        if (
          agent.lifecycle === "running" &&
          previous !== "running" &&
          previous !== "initializing" &&
          !this.isOrchestratorRunning()
        ) {
          this.queue?.push({ agentId: agent.id, reason: "started" });
        }
      },
      { replayState: false },
    );
  }

  private noteNotice(notice: VoiceNotice): void {
    const { agentId, reason } = notice;
    if (isUnheardReason(reason) && (this.queue || this.followed.has(agentId))) {
      this.unheard.add(agentId, reason);
    }
    this.queue?.push(notice);
  }

  private async replayUnheard(queue: VoiceNoticeQueue): Promise<void> {
    await this.unheardLoaded;
    if (this.queue !== queue) return;
    for (const entry of this.unheard.list()) {
      queue.push({ agentId: entry.agentId, reason: entry.reason });
    }
  }

  private settleNotices(notices: VoiceNotice[], heard: boolean): void {
    for (const notice of notices) {
      if (!isUnheardReason(notice.reason)) continue;
      if (heard) {
        this.unheard.remove(notice.agentId, notice.reason);
        this.followed.delete(notice.agentId);
        continue;
      }
      const attempts = (notice.attempts ?? 0) + 1;
      if (attempts <= UNHEARD_MAX_REPEATS) this.queue?.push({ ...notice, attempts });
    }
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

  private systemPrompt(): string {
    return this.options.live
      ? VOICE_BACKEND_SYSTEM_PROMPT
      : buildVoiceModeSystemPrompt(VOICE_ORCHESTRATOR_SYSTEM_PROMPT, true);
  }

  /** The orchestrator outlives daemon upgrades; an older prompt would keep old behavior forever. */
  private async refreshSystemPrompt(agent: ManagedAgent): Promise<void> {
    const prompt = this.systemPrompt();
    if (agent.config.systemPrompt === prompt || agent.lifecycle === "running") return;
    try {
      await this.options.agentManager.reloadAgentSession(agent.id, { systemPrompt: prompt });
      this.logger.info({ agentId: agent.id }, "Refreshed the voice orchestrator prompt");
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: agent.id },
        "Failed to refresh the orchestrator prompt",
      );
    }
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
        systemPrompt: this.systemPrompt(),
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
    if (this.call?.isUserSpeaking() || this.call?.isAssistantSpeaking?.()) return true;
    return !this.call?.announce && this.isOrchestratorRunning();
  }

  private dropIfStale(notice: VoiceNotice): boolean {
    const stale = this.isNoticeStale(notice);
    if (stale && isUnheardReason(notice.reason)) {
      this.unheard.remove(notice.agentId, notice.reason);
    }
    return stale;
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
    const described: Array<{ notice: VoiceNotice; text: string; urgent: boolean }> = [];
    for (const notice of notices) {
      const line = await this.describeNotice(notice);
      if (line) described.push({ notice, ...line });
    }
    if (described.length === 0) return;
    const lines = described.map((entry) => entry.text);
    const delivered = described.map((entry) => entry.notice);
    if (this.call?.announce) {
      this.call.announce(lines, {
        urgent: described.some((entry) => entry.urgent),
        onOutcome: (heard) => this.settleNotices(delivered, heard),
      });
      return;
    }
    if (!this.knownAgentId) return;
    // A spoken request replaces the orchestrator's running turn, so a notice turn it overlapped
    // was cut off before the user heard it.
    const spokenBefore = this.spokenRequests;
    try {
      await this.runTurn(async () => buildNoticePrompt(lines), false);
      this.settleNotices(delivered, this.spokenRequests === spokenBefore);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to deliver voice notices");
      this.settleNotices(delivered, false);
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

  private async describeNotice(
    notice: VoiceNotice,
  ): Promise<{ text: string; urgent: boolean } | null> {
    const { agentManager } = this.options;
    const agent = agentManager.getAgent(notice.agentId);
    if (!agent) return null;
    const name = await this.describeAgentName(agent);
    const work = agentManager.getLiveWorkSummary(agent.id);
    const task = work.request ? ` Its task: ${speakableClip(work.request, 200)}` : "";
    const again = notice.attempts ? " (Repeating: the user was cut off before hearing this.)" : "";
    switch (notice.reason) {
      case "permission": {
        const request = [...agent.pendingPermissions.values()].at(-1);
        if (!request) return null;
        const summary = await this.localFleet.settledSummary(agent, NOTICE_SUMMARY_WAIT_MS);
        const context = summary ? ` Context: ${summary}` : task;
        return {
          text: `${name} is waiting for permission to ${describePermission(request)}.${context}${again}`,
          urgent: true,
        };
      }
      case "error": {
        const summary = await this.localFleet.settledSummary(agent, NOTICE_SUMMARY_WAIT_MS);
        return {
          text: `${name} failed: ${speakableClip(agent.lastError ?? "unknown error", 240)}.${summary ? ` ${summary}` : task}${again}`,
          urgent: true,
        };
      }
      case "finished": {
        const message = await agentManager.getLastAssistantMessage(agent.id).catch(() => null);
        if (!message?.trim()) {
          // A provider process that dies mid-turn (often while waiting on a permission) ends
          // the run without an error or any reply; saying "finished" would hide the failure.
          return {
            text: `${name} stopped without giving any result; it may have crashed or been stuck waiting.${task}${again}`,
            urgent: true,
          };
        }
        const summary = await this.localFleet.settledSummary(agent, NOTICE_SUMMARY_WAIT_MS);
        return {
          text: summary
            ? `${name} finished: ${summary}${again}`
            : `${name} finished.${task} Its final message: ${speakableClip(message, 600)}${again}`,
          urgent: false,
        };
      }
      case "started":
        return { text: `${name} started working.${task}`, urgent: false };
      case "progress": {
        const digest = this.localFleet.digestAgent(agent);
        const now = digest.summary ?? digest.now;
        return now ? { text: `${name} is now: ${speakableClip(now, 200)}.`, urgent: false } : null;
      }
    }
  }

  private describeStatus(agent: ManagedAgent): string {
    const status = this.describeBaseStatus(agent);
    return this.unheard.has(agent.id) ? `${status}, not yet told to the user` : status;
  }

  private describeBaseStatus(agent: ManagedAgent): string {
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

/** "Alexanders-MacBook-Pro.local" → "Alexanders MacBook Pro": how a host is said aloud. */
function describeHostname(name: string): string {
  return (
    name
      .replace(/\.local$/i, "")
      .replace(/[-_]+/g, " ")
      .trim() || "this computer"
  );
}
