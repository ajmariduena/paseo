import { v4 as uuidv4 } from "uuid";
import type pino from "pino";
import type {
  SpeechClip,
  SpeechToTextProvider,
  TextToSpeechProvider,
} from "../../speech/speech-provider.js";
import type { CallTranscript } from "../call-transcript.js";
import type { VoiceOrchestrator } from "../orchestrator.js";
import {
  UtteranceAssembler,
  type UtterancePart,
  type UtteranceReceipt,
} from "./utterance-assembler.js";

// Text normally arrives first; the audio gets this long to finish so Scribe can transcribe it.
const AUDIO_GRACE_MS = 2_500;
const STALE_UTTERANCE_MS = 5 * 60_000;
const OUTBOX_LIMIT = 80;
const HISTORY_LIMIT = 24;
const PUSH_AFTER_MS = 10_000;

export type VoiceMessagesItemKind = "heard" | "reply" | "notice" | "status";
export type VoiceMessagesStatusCode = "not_heard" | "backend_failed";

export interface VoiceMessagesItem {
  seq: number;
  id: string;
  kind: VoiceMessagesItemKind;
  text: string;
  code: VoiceMessagesStatusCode | null;
  utteranceId: string | null;
  createdAt: string;
  audio: { mimeType: string; size: number } | null;
}

interface StoredItem {
  item: VoiceMessagesItem;
  audio: Buffer | null;
  pushTimer: ReturnType<typeof setTimeout> | null;
}

export interface VoiceMessagesSpeech {
  resolveStt(): SpeechToTextProvider | null;
  resolveTts(): TextToSpeechProvider | null;
}

export interface VoiceMessagesCallOptions {
  callId: string;
  orchestrator: VoiceOrchestrator;
  speech: VoiceMessagesSpeech;
  history: string[];
  greet: boolean;
  sendPush:
    | ((payload: { title: string; body: string; data: Record<string, unknown> }) => void)
    | null;
  logger: pino.Logger;
}

type UpdateListener = (item: VoiceMessagesItem) => void;

/**
 * A voice call that survives a bad network: the phone sends finished utterances
 * (device text first, compressed audio behind), and every reply or update goes into
 * a numbered outbox the phone reads at its own pace. Nothing depends on a live socket.
 */
export class VoiceMessagesCall {
  readonly callId: string;
  private readonly logger: pino.Logger;
  private readonly assembler = new UtteranceAssembler();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly outbox: StoredItem[] = [];
  private readonly history: string[];
  private nextSeq = 1;
  private ackedSeq = 0;
  private work: Promise<void> = Promise.resolve();
  private detach: (() => void) | null = null;
  private listener: UpdateListener | null = null;
  private closed = false;
  private lastContactAt = Date.now();
  private pendingUtterances = 0;
  private transcript: CallTranscript | null = null;
  /** Notices whose delivery is confirmed once the phone syncs past their seq. */
  private readonly ackWaiters = new Map<number, (heard: boolean) => void>();

  constructor(private readonly options: VoiceMessagesCallOptions) {
    this.callId = options.callId;
    this.logger = options.logger.child({ module: "voice-messages", callId: options.callId });
    this.history = options.history.slice(-HISTORY_LIMIT);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  get idleMs(): number {
    return Date.now() - this.lastContactAt;
  }

  start(): void {
    this.transcript =
      this.options.orchestrator.openTranscript?.({
        callId: this.callId,
        mode: "messages",
      }) ?? null;
    this.detach = this.options.orchestrator.attachCall({
      isUserSpeaking: () => this.pendingUtterances > 0,
      announce: (lines, options) => {
        this.transcript?.record("notice", lines.join(" · "), {
          urgent: options?.urgent ?? false,
        });
        this.enqueue(() => this.narrateNotices(lines, options?.onOutcome));
      },
    });
    if (this.options.greet) this.enqueue(() => this.narrateCallStart());
  }

  /** The client that last spoke for this call gets live updates; others catch up through sync. */
  setListener(listener: UpdateListener): void {
    this.listener = listener;
  }

  clearListener(listener: UpdateListener): void {
    if (this.listener === listener) this.listener = null;
  }

  receive(part: UtterancePart): UtteranceReceipt {
    this.touch();
    if (this.closed) return { receivedChunks: 0, audioComplete: false, isNew: false };
    const receipt = this.assembler.accept(part);
    if (this.assembler.hasFinished(part.utteranceId)) return receipt;
    if (receipt.audioComplete) {
      this.finishUtterance(part.utteranceId);
    } else if (this.assembler.hasDeviceText(part.utteranceId)) {
      this.armGraceTimer(part.utteranceId);
    }
    this.assembler.prune(STALE_UTTERANCE_MS);
    return receipt;
  }

  addLateReply(text: string): void {
    this.enqueue(async () => {
      this.pushHistory(`Assistant: ${text}`);
      await this.addSpokenItem("reply", text, null);
    });
  }

  /** Items after `afterSeq`; also records that the phone has everything up to it. */
  sync(afterSeq: number): VoiceMessagesItem[] {
    this.touch();
    this.ackedSeq = Math.max(this.ackedSeq, afterSeq);
    for (const [seq, report] of this.ackWaiters) {
      if (seq > this.ackedSeq) continue;
      this.ackWaiters.delete(seq);
      report(true);
    }
    for (const stored of this.outbox) {
      if (stored.item.seq <= this.ackedSeq && stored.pushTimer) {
        clearTimeout(stored.pushTimer);
        stored.pushTimer = null;
      }
    }
    return this.outbox.filter((stored) => stored.item.seq > afterSeq).map((stored) => stored.item);
  }

  readAudio(
    seq: number,
    offset: number,
    length: number,
  ): { audio: Buffer; total: number; mimeType: string } | null {
    this.touch();
    const stored = this.outbox.find((entry) => entry.item.seq === seq);
    if (!stored?.audio || !stored.item.audio) return null;
    const start = Math.max(0, Math.min(offset, stored.audio.length));
    return {
      audio: stored.audio.subarray(start, start + Math.max(0, length)),
      total: stored.audio.length,
      mimeType: stored.item.audio.mimeType,
    };
  }

  close(options: { handoff?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;
    this.detach?.();
    this.detach = null;
    this.listener = null;
    if (options.handoff) this.options.orchestrator.saveCallHistory(this.history, "messages");
    void this.transcript?.close({ handoff: options.handoff ?? false });
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    for (const stored of this.outbox) {
      if (stored.pushTimer) clearTimeout(stored.pushTimer);
    }
    const unconfirmed = [...this.ackWaiters.values()];
    this.ackWaiters.clear();
    for (const report of unconfirmed) report(false);
  }

  private touch(): void {
    this.lastContactAt = Date.now();
  }

  private armGraceTimer(utteranceId: string): void {
    if (this.graceTimers.has(utteranceId)) return;
    const timer = setTimeout(() => {
      this.graceTimers.delete(utteranceId);
      this.finishUtterance(utteranceId);
    }, AUDIO_GRACE_MS);
    this.graceTimers.set(utteranceId, timer);
  }

  private finishUtterance(utteranceId: string): void {
    const timer = this.graceTimers.get(utteranceId);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(utteranceId);
    const utterance = this.assembler.finish(utteranceId);
    if (!utterance) return;
    this.pendingUtterances += 1;
    this.enqueue(async () => {
      try {
        const transcript = await this.transcribe(utterance.audio, utterance.deviceText);
        if (!transcript) {
          this.addItem({ kind: "status", text: "", code: "not_heard", utteranceId });
          this.transcript?.record("status", "not_heard");
          return;
        }
        this.addItem({ kind: "heard", text: transcript, utteranceId });
        this.pushHistory(`User: ${transcript}`);
        const reply = await this.options.orchestrator.runDelegation({
          request: transcript,
          history: [...this.history],
        });
        this.pushHistory(`Assistant: ${reply}`);
        await this.addSpokenItem("reply", reply, utteranceId);
      } catch (error) {
        this.logger.warn({ err: error, utteranceId }, "Voice message failed");
        this.addItem({ kind: "status", text: "", code: "backend_failed", utteranceId });
        this.transcript?.record("status", "backend_failed");
      } finally {
        this.pendingUtterances = Math.max(0, this.pendingUtterances - 1);
      }
    });
  }

  private async transcribe(
    audio: { data: Buffer; mimeType: string } | null,
    deviceText: string | null,
  ): Promise<string | null> {
    const stt = this.options.speech.resolveStt();
    if (audio && stt?.transcribeClip) {
      try {
        const result = await stt.transcribeClip(
          { audio: audio.data, mimeType: audio.mimeType },
          this.options.orchestrator.language ?? undefined,
        );
        if (result.text.trim()) return result.text.trim();
      } catch (error) {
        this.logger.warn({ err: error }, "Server transcription failed; using device text");
      }
    }
    return deviceText?.trim() || null;
  }

  private async narrateNotices(
    lines: string[],
    onOutcome: ((heard: boolean) => void) | undefined,
  ): Promise<void> {
    try {
      const text = await this.options.orchestrator.narrate({
        kind: "notices",
        lines,
        history: [...this.history],
      });
      this.pushHistory(`Assistant: ${text}`);
      const seq = await this.addSpokenItem("notice", text, null);
      if (!onOutcome) return;
      if (this.closed) onOutcome(false);
      else if (seq <= this.ackedSeq) onOutcome(true);
      else this.ackWaiters.set(seq, onOutcome);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to narrate voice notices");
      onOutcome?.(false);
    }
  }

  private async narrateCallStart(): Promise<void> {
    try {
      const text = await this.options.orchestrator.narrate({
        kind: "call_start",
        lines: [],
        history: [],
      });
      this.pushHistory(`Assistant: ${text}`);
      await this.addSpokenItem("notice", text, null);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to greet the messages call");
    }
  }

  /** Text goes out at once; the compressed audio follows as an update of the same item. */
  private async addSpokenItem(
    kind: "reply" | "notice",
    text: string,
    utteranceId: string | null,
  ): Promise<number> {
    const stored = this.addItem({ kind, text, utteranceId });
    if (kind === "notice") this.armPush(stored);
    const clip = await this.synthesize(text);
    if (!clip || this.closed) return stored.item.seq;
    stored.audio = clip.audio;
    stored.item = { ...stored.item, audio: { mimeType: clip.mimeType, size: clip.audio.length } };
    this.listener?.(stored.item);
    return stored.item.seq;
  }

  private async synthesize(text: string): Promise<SpeechClip | null> {
    const tts = this.options.speech.resolveTts();
    if (!tts?.synthesizeCompressed || !text.trim()) return null;
    try {
      return await tts.synthesizeCompressed(text);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Compressed speech failed; the phone will use its own voice",
      );
      return null;
    }
  }

  private addItem(params: {
    kind: VoiceMessagesItemKind;
    text: string;
    code?: VoiceMessagesStatusCode;
    utteranceId: string | null;
  }): StoredItem {
    const stored: StoredItem = {
      item: {
        seq: this.nextSeq,
        id: uuidv4(),
        kind: params.kind,
        text: params.text,
        code: params.code ?? null,
        utteranceId: params.utteranceId,
        createdAt: new Date().toISOString(),
        audio: null,
      },
      audio: null,
      pushTimer: null,
    };
    this.nextSeq += 1;
    this.outbox.push(stored);
    while (this.outbox.length > OUTBOX_LIMIT) {
      const dropped = this.outbox.shift();
      if (dropped?.pushTimer) clearTimeout(dropped.pushTimer);
    }
    if (!this.closed) this.listener?.(stored.item);
    return stored;
  }

  /** A notice the phone hasn't picked up in time goes out as a push, which survives a dead socket. */
  private armPush(stored: StoredItem): void {
    const sendPush = this.options.sendPush;
    if (!sendPush) return;
    stored.pushTimer = setTimeout(() => {
      stored.pushTimer = null;
      if (this.closed || stored.item.seq <= this.ackedSeq) return;
      sendPush({
        title: "Paseo",
        body: stored.item.text,
        data: { voiceMessages: { callId: this.callId, seq: stored.item.seq } },
      });
    }, PUSH_AFTER_MS);
    stored.pushTimer.unref?.();
  }

  private pushHistory(line: string): void {
    const match = /^(User|Assistant):\s*([\s\S]*)$/.exec(line);
    if (match) this.transcript?.record(match[1] === "User" ? "user" : "assistant", match[2]);
    this.history.push(line);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
  }

  private enqueue(task: () => Promise<void>): void {
    const previous = this.work;
    this.work = (async () => {
      await previous;
      if (!this.closed) await task();
    })().catch((error: unknown) => {
      this.logger.warn({ err: error }, "Voice messages task failed");
    });
  }
}
