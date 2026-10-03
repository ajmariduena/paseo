import { v4 as uuidv4 } from "uuid";
import type pino from "pino";
import type { SessionOutboundMessage } from "../../messages.js";
import type { GptLiveEngineConfig, VoiceOrchestrator } from "../orchestrator.js";
import {
  buildLiveFleetSnapshot,
  buildLiveGreeting,
  buildLiveInstructions,
  buildLiveResume,
} from "../prompt.js";
import {
  GPT_LIVE_SAMPLE_RATE,
  GptLiveConnection,
  describeError,
  type GptLiveServerEvent,
} from "./live-connection.js";
import { FloorQueue, SpeechFloor, isEchoOfAssistant } from "./speech-floor.js";

const OUTPUT_FORMAT = `pcm;rate=${GPT_LIVE_SAMPLE_RATE}`;
const BYTES_PER_MS = (GPT_LIVE_SAMPLE_RATE * 2) / 1000;
// The first chunk of a reply is small for a fast start; later ones are larger to avoid gaps.
const FIRST_CHUNK_MS = 200;
const CHUNK_MS = 600;
// GPT-Live has no "output done" event on WebSockets; a pause this long ends an utterance.
const UTTERANCE_GAP_MS = 350;
const USER_SPEECH_IDLE_MS = 900;
const HISTORY_LIMIT = 24;
// The sideband's reflected output audio is always 24 kHz PCM16, whatever the transport uses.
const REFLECTED_BYTES_PER_MS = (24_000 * 2) / 1000;
// While the assistant is audible, a transcript must be at least this long to count as the user.
const BARGE_IN_MIN_WORDS = 3;
// Over WebRTC the session runs before the phone's media connects; greet once its audio arrives.
const GREETING_FALLBACK_MS = 6_000;

export interface GptLiveCallOptions {
  engine: GptLiveEngineConfig;
  orchestrator: VoiceOrchestrator;
  emit: (message: SessionOutboundMessage) => void;
  logger: pino.Logger;
  /** Attach as a sideband to this WebRTC session instead of carrying the audio. */
  sidebandSessionId?: string;
  createConnection?: () => GptLiveConnection;
}

/**
 * A global voice call on GPT-Live: the app's microphone audio goes to GPT-Live, its
 * speech comes back as `audio_output`, and delegated requests run on the orchestrator.
 */
export class GptLiveCall {
  private readonly connection: GptLiveConnection;
  private detach: (() => void) | null = null;
  private unregister: (() => void) | null = null;
  private closed = false;

  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private groupId: string | null = null;
  private chunkIndex = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;

  private userTurn = "";
  private sinceLastDelegation = "";
  private assistantTurn = "";
  private readonly history: string[] = [];
  private unconfirmedSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  private userSpeakingSignalled = false;
  private userIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private assistantIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingGreeting: string | null = null;
  private greetingTimer: ReturnType<typeof setTimeout> | null = null;
  private recentAssistantText = "";
  private pendingDelegations = 0;
  private readonly floor = new SpeechFloor();
  private readonly outbox = new FloorQueue(this.floor, {
    isAwaitingResult: () => this.pendingDelegations > 0,
  });

  constructor(private readonly options: GptLiveCallOptions) {
    this.connection = options.createConnection?.() ?? new GptLiveConnection();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    const { engine, orchestrator } = this.options;
    const previous = orchestrator.takeRecentHistory("messages");
    this.history.push(...previous);
    this.connection.on("event", (event) => this.handleEvent(event));
    this.connection.on("close", () => {
      if (this.closed) return;
      this.options.logger.warn("GPT-Live connection closed during a call");
      this.close();
    });
    if (this.options.sidebandSessionId) {
      await this.connection.attach({
        apiKey: engine.apiKey,
        sessionId: this.options.sidebandSessionId,
      });
    } else {
      await this.connection.start({
        apiKey: engine.apiKey,
        model: engine.model,
        voice: engine.voice,
        instructions: buildLiveInstructions(orchestrator.language),
      });
    }
    this.detach = orchestrator.attachCall({
      isUserSpeaking: () => this.floor.isUserSpeaking(),
      isAssistantSpeaking: () => this.floor.isAssistantSpeaking(),
      announce: (lines, options) =>
        this.outbox.push(options?.urgent ? "urgent" : "routine", () =>
          this.connection.append("commentary", lines.join("\n"), null),
        ),
      onFleetChanged: () => void this.pushFleetSnapshot(),
    });
    this.unregister = orchestrator.registerLiveCall(this);
    const fleet = await orchestrator.describeFleet().catch(() => []);
    this.connection.append("thinking", buildLiveFleetSnapshot(fleet), null);
    const greeting =
      previous.length > 0
        ? buildLiveResume(previous, orchestrator.language)
        : buildLiveGreeting(fleet, orchestrator.language);
    if (!this.options.sidebandSessionId) {
      this.connection.append("instructions", greeting, null);
      return;
    }
    this.pendingGreeting = greeting;
    this.greetingTimer = setTimeout(() => this.sendPendingGreeting(), GREETING_FALLBACK_MS);
  }

  private sendPendingGreeting(): void {
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.greetingTimer = null;
    const greeting = this.pendingGreeting;
    this.pendingGreeting = null;
    if (greeting && !this.closed) this.connection.append("instructions", greeting, null);
  }

  private async pushFleetSnapshot(): Promise<void> {
    const fleet = await this.options.orchestrator.describeFleet().catch(() => null);
    if (!fleet || this.closed) return;
    this.connection.append("thinking", buildLiveFleetSnapshot(fleet), null);
  }

  appendAudio(pcm16: Buffer): void {
    if (this.closed) return;
    this.connection.appendAudio(pcm16);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach?.();
    this.detach = null;
    this.unregister?.();
    this.unregister = null;
    this.options.orchestrator.saveCallHistory(this.history, "live");
    this.flushAudio(true);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    if (this.userIdleTimer) clearTimeout(this.userIdleTimer);
    if (this.assistantIdleTimer) clearTimeout(this.assistantIdleTimer);
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    if (this.unconfirmedSpeechTimer) clearTimeout(this.unconfirmedSpeechTimer);
    this.outbox.close();
    this.connection.close();
  }

  private handleEvent(event: GptLiveServerEvent): void {
    switch (event.type) {
      case "session.output_audio.delta": {
        const audio = Buffer.from((event as { delta: string }).delta, "base64");
        // A sideband only gets reflected copies; the phone already hears it over WebRTC.
        if (this.options.sidebandSessionId) {
          this.floor.noteAssistantAudio(audio.length / REFLECTED_BYTES_PER_MS);
          return;
        }
        this.handleOutputAudio(audio);
        return;
      }
      case "session.input_audio.append":
        if (this.pendingGreeting) this.sendPendingGreeting();
        return;
      case "session.input_transcript.delta":
        this.handleUserSpeech((event as { delta: string }).delta);
        return;
      case "session.output_transcript.delta": {
        const delta = (event as { delta: string }).delta;
        this.assistantTurn += delta;
        this.recentAssistantText = `${this.recentAssistantText}${delta}`.slice(-600);
        this.floor.noteAssistantText();
        if (this.options.sidebandSessionId) this.scheduleAssistantCommit();
        return;
      }
      case "session.delegation.created":
        void this.handleDelegation((event as { delegation: { id: string } }).delegation.id);
        return;
      case "error":
        this.options.logger.warn({ error: describeError(event) }, "GPT-Live error event");
        return;
      default:
        return;
    }
  }

  /** Without audio there are no utterance gaps to end a turn, so a transcript pause ends it. */
  private scheduleAssistantCommit(): void {
    if (this.assistantIdleTimer) clearTimeout(this.assistantIdleTimer);
    this.assistantIdleTimer = setTimeout(() => {
      this.assistantIdleTimer = null;
      if (this.assistantTurn.trim()) this.pushHistory(`Assistant: ${this.assistantTurn.trim()}`);
      this.assistantTurn = "";
    }, USER_SPEECH_IDLE_MS);
  }

  private handleOutputAudio(audio: Buffer): void {
    if (this.closed || audio.length === 0) return;
    this.floor.noteAssistantAudio(audio.length / BYTES_PER_MS);
    if (this.userTurn) this.commitUserTurn();
    this.groupId ??= uuidv4();
    this.pendingAudio.push(audio);
    this.pendingAudioBytes += audio.length;
    const targetMs = this.chunkIndex === 0 ? FIRST_CHUNK_MS : CHUNK_MS;
    if (this.pendingAudioBytes >= targetMs * BYTES_PER_MS) this.flushAudio(false);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => this.flushAudio(true), UTTERANCE_GAP_MS);
  }

  private flushAudio(isLast: boolean): void {
    if (!this.groupId) return;
    if (this.pendingAudioBytes === 0 && !isLast) return;
    // A trailing empty chunk would not play; a few ms of silence closes the group instead.
    const audio =
      this.pendingAudioBytes > 0
        ? Buffer.concat(this.pendingAudio)
        : Buffer.alloc(Math.round(BYTES_PER_MS * 20));
    this.options.emit({
      type: "audio_output",
      payload: {
        id: uuidv4(),
        groupId: this.groupId,
        chunkIndex: this.chunkIndex,
        isLastChunk: isLast,
        audio: audio.toString("base64"),
        format: OUTPUT_FORMAT,
        isVoiceMode: true,
      },
    });
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.chunkIndex += 1;
    if (isLast) {
      this.groupId = null;
      this.chunkIndex = 0;
      if (this.assistantTurn.trim()) this.pushHistory(`Assistant: ${this.assistantTurn.trim()}`);
      this.assistantTurn = "";
    }
  }

  private handleUserSpeech(delta: string): void {
    this.userTurn += delta;
    if (
      !this.userSpeakingSignalled &&
      this.floor.isAssistantSpeaking() &&
      !this.isRealUserSpeech()
    ) {
      // The assistant hearing itself (or a short noise) must not cut its own reply; text
      // that never grows into real speech is dropped.
      if (this.unconfirmedSpeechTimer) clearTimeout(this.unconfirmedSpeechTimer);
      this.unconfirmedSpeechTimer = setTimeout(() => {
        this.unconfirmedSpeechTimer = null;
        if (!this.userSpeakingSignalled) this.userTurn = "";
      }, USER_SPEECH_IDLE_MS);
      return;
    }
    if (this.unconfirmedSpeechTimer) clearTimeout(this.unconfirmedSpeechTimer);
    this.unconfirmedSpeechTimer = null;
    this.sinceLastDelegation += delta;
    this.floor.noteUserSpeech();
    const relaysAudio = !this.options.sidebandSessionId;
    if (!this.userSpeakingSignalled) {
      this.userSpeakingSignalled = true;
      // Barge-in: the app drops queued assistant audio when the user starts talking.
      this.discardPendingAudio();
      if (relaysAudio) {
        this.options.emit({ type: "voice_input_state", payload: { isSpeaking: true } });
      }
    }
    if (this.userIdleTimer) clearTimeout(this.userIdleTimer);
    this.userIdleTimer = setTimeout(() => {
      this.userSpeakingSignalled = false;
      if (relaysAudio) {
        this.options.emit({ type: "voice_input_state", payload: { isSpeaking: false } });
      }
      this.commitUserTurn();
    }, USER_SPEECH_IDLE_MS);
  }

  private isRealUserSpeech(): boolean {
    const heard = this.userTurn.trim();
    if (isEchoOfAssistant(heard, this.recentAssistantText)) return false;
    return heard.split(/\s+/).length >= BARGE_IN_MIN_WORDS;
  }

  private discardPendingAudio(): void {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.groupId = null;
    this.chunkIndex = 0;
    if (this.assistantTurn.trim()) this.pushHistory(`Assistant: ${this.assistantTurn.trim()}…`);
    this.assistantTurn = "";
  }

  private commitUserTurn(): void {
    const text = this.userTurn.trim();
    this.userTurn = "";
    if (!text) return;
    this.pushHistory(`User: ${text}`);
    this.options.orchestrator.noteUserUtterance(text);
  }

  private pushHistory(line: string): void {
    this.history.push(line);
    if (this.history.length > HISTORY_LIMIT)
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  private async handleDelegation(delegationId: string): Promise<void> {
    this.commitUserTurn();
    const request = this.sinceLastDelegation.trim();
    this.sinceLastDelegation = "";
    this.pendingDelegations += 1;
    try {
      const result = await this.options.orchestrator.runDelegation({
        request,
        history: [...this.history],
      });
      if (this.closed) {
        // The call switched to messages mode while the agent worked; say it there.
        this.options.orchestrator.deliverLateReply(result);
        return;
      }
      this.outbox.push("result", () => this.connection.append("commentary", result, delegationId));
    } catch (error) {
      this.options.logger.warn({ err: error }, "GPT-Live delegation failed");
      if (this.closed) return;
      this.outbox.push("result", () =>
        this.connection.append(
          "commentary",
          "The request could not be completed because the backend failed. Tell the user briefly.",
          delegationId,
        ),
      );
    } finally {
      this.pendingDelegations = Math.max(0, this.pendingDelegations - 1);
    }
  }
}
