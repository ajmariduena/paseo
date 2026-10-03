import { v4 as uuidv4 } from "uuid";
import type pino from "pino";
import type { SessionOutboundMessage } from "../../messages.js";
import type { GptLiveEngineConfig, VoiceOrchestrator } from "../orchestrator.js";
import { buildLiveFleetSnapshot, buildLiveGreeting, buildLiveInstructions } from "../prompt.js";
import {
  GPT_LIVE_SAMPLE_RATE,
  GptLiveConnection,
  describeError,
  type GptLiveServerEvent,
} from "./live-connection.js";

const OUTPUT_FORMAT = `pcm;rate=${GPT_LIVE_SAMPLE_RATE}`;
const BYTES_PER_MS = (GPT_LIVE_SAMPLE_RATE * 2) / 1000;
// The first chunk of a reply is small for a fast start; later ones are larger to avoid gaps.
const FIRST_CHUNK_MS = 200;
const CHUNK_MS = 600;
// GPT-Live has no "output done" event on WebSockets; a pause this long ends an utterance.
const UTTERANCE_GAP_MS = 350;
const USER_SPEECH_IDLE_MS = 900;
const HISTORY_LIMIT = 24;

export interface GptLiveCallOptions {
  engine: GptLiveEngineConfig;
  orchestrator: VoiceOrchestrator;
  emit: (message: SessionOutboundMessage) => void;
  logger: pino.Logger;
  createConnection?: () => GptLiveConnection;
}

/**
 * A global voice call on GPT-Live: the app's microphone audio goes to GPT-Live, its
 * speech comes back as `audio_output`, and delegated requests run on the orchestrator.
 */
export class GptLiveCall {
  private readonly connection: GptLiveConnection;
  private detach: (() => void) | null = null;
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
  private lastUserSpeechAt = 0;
  private userSpeakingSignalled = false;
  private userIdleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: GptLiveCallOptions) {
    this.connection = options.createConnection?.() ?? new GptLiveConnection();
  }

  async start(): Promise<void> {
    const { engine, orchestrator } = this.options;
    this.connection.on("event", (event) => this.handleEvent(event));
    this.connection.on("close", () => {
      if (!this.closed) this.options.logger.warn("GPT-Live connection closed during a call");
    });
    await this.connection.start({
      apiKey: engine.apiKey,
      model: engine.model,
      voice: engine.voice,
      instructions: buildLiveInstructions(orchestrator.language),
    });
    this.detach = orchestrator.attachCall({
      isUserSpeaking: () => Date.now() - this.lastUserSpeechAt < USER_SPEECH_IDLE_MS,
      announce: (lines) => this.connection.append("commentary", lines.join("\n"), null),
      onFleetChanged: () => void this.pushFleetSnapshot(),
    });
    const fleet = await orchestrator.describeFleet().catch(() => []);
    this.connection.append("thinking", buildLiveFleetSnapshot(fleet), null);
    this.connection.append("instructions", buildLiveGreeting(fleet, orchestrator.language), null);
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
    this.flushAudio(true);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    if (this.userIdleTimer) clearTimeout(this.userIdleTimer);
    this.connection.close();
  }

  private handleEvent(event: GptLiveServerEvent): void {
    switch (event.type) {
      case "session.output_audio.delta":
        this.handleOutputAudio(Buffer.from((event as { delta: string }).delta, "base64"));
        return;
      case "session.input_transcript.delta":
        this.handleUserSpeech((event as { delta: string }).delta);
        return;
      case "session.output_transcript.delta":
        this.assistantTurn += (event as { delta: string }).delta;
        return;
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

  private handleOutputAudio(audio: Buffer): void {
    if (this.closed || audio.length === 0) return;
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
    this.sinceLastDelegation += delta;
    this.lastUserSpeechAt = Date.now();
    if (!this.userSpeakingSignalled) {
      this.userSpeakingSignalled = true;
      // Barge-in: the app drops queued assistant audio when the user starts talking.
      this.discardPendingAudio();
      this.options.emit({ type: "voice_input_state", payload: { isSpeaking: true } });
    }
    if (this.userIdleTimer) clearTimeout(this.userIdleTimer);
    this.userIdleTimer = setTimeout(() => {
      this.userSpeakingSignalled = false;
      this.options.emit({ type: "voice_input_state", payload: { isSpeaking: false } });
      this.commitUserTurn();
    }, USER_SPEECH_IDLE_MS);
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
    try {
      const result = await this.options.orchestrator.runDelegation({
        request,
        history: [...this.history],
      });
      if (this.closed) return;
      this.connection.append("commentary", result, delegationId);
    } catch (error) {
      this.options.logger.warn({ err: error }, "GPT-Live delegation failed");
      if (this.closed) return;
      this.connection.append(
        "commentary",
        "The request could not be completed because the backend failed. Tell the user briefly.",
        delegationId,
      );
    }
  }
}
