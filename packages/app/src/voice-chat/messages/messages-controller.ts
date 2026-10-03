import { Buffer } from "buffer";
import type { VoiceMessagesItem } from "@getpaseo/protocol/messages";
import type { AudioEngine } from "@/audio/audio-engine-types";
import {
  THINKING_TONE_NATIVE_PCM_BASE64,
  THINKING_TONE_NATIVE_PCM_DURATION_MS,
} from "@/utils/thinking-tone.native-pcm";
import type { DeviceSpeech, PcmAudio } from "@/voice-chat/messages/device-speech-types";
import { EnergyVad, VAD_SAMPLE_RATE, pcm16Rms } from "@/voice-chat/messages/energy-vad";

const UPLOAD_CHUNK_BYTES = 12 * 1024;
const DOWNLOAD_CHUNK_BYTES = 16 * 1024;
// Device text normally beats the recording; wait this long for it before sending audio alone.
const TEXT_WAIT_MS = 1_500;
// How long a reply waits for the host's voice before the phone speaks it with its own.
const AUDIO_WAIT_MS = 4_000;
const SYNC_INTERVAL_MS = 4_000;
const MAX_RETRY_DELAY_MS = 8_000;
const OUTGOING_MAX_AGE_MS = 3 * 60_000;
const BARGE_IN_MS = 300;
const BARGE_IN_MIN_RMS = 0.08;
const CUE_GAP_MS = 1_200;
// A reply that never comes (the host lost it) must not leave the call "waiting" forever.
const REPLY_WAIT_MAX_MS = 150_000;
const KEEP_AWAKE_TAG = "paseo:voice-messages";

export type VoiceMessagesPhase = "idle" | "listening" | "recording" | "waiting" | "speaking";

export interface VoiceMessagesSnapshot {
  active: boolean;
  serverId: string | null;
  callId: string | null;
  phase: VoiceMessagesPhase;
  connected: boolean;
  pendingSends: number;
  isMuted: boolean;
  lastHeard: string | null;
  lastSpoken: string | null;
}

export interface VoiceMessagesTransport {
  start(params: {
    callId: string;
    greet: boolean;
  }): Promise<{ lastSeq: number; language: string | null }>;
  sendUtterance(params: {
    callId: string;
    utteranceId: string;
    text?: string;
    chunkIndex?: number;
    chunkCount?: number;
    audio?: string;
    mimeType?: string;
  }): Promise<{ receivedChunks: number; audioComplete: boolean; error: string | null }>;
  sync(params: {
    callId: string;
    afterSeq: number;
  }): Promise<{ active: boolean; items: VoiceMessagesItem[] }>;
  getAudio(params: {
    callId: string;
    seq: number;
    offset: number;
    length: number;
  }): Promise<{ audio: string | null; total: number; mimeType: string | null }>;
  end(params: { callId: string; handoff?: boolean }): Promise<void>;
  isConnected(): boolean;
  subscribeConnection(listener: (connected: boolean) => void): () => void;
  subscribeUpdates(listener: (callId: string, item: VoiceMessagesItem) => void): () => void;
}

export type VoiceMessagesPhraseKey = "notHeard" | "backendFailed";

export interface VoiceMessagesControllerDeps {
  engine: AudioEngine;
  speech: DeviceSpeech;
  phrase(key: VoiceMessagesPhraseKey, language: string): string;
  log(kind: string, detail?: Record<string, unknown>): void;
  activateKeepAwake(tag: string): Promise<void>;
  deactivateKeepAwake(tag: string): Promise<void>;
  createId(): string;
  now?: () => number;
}

interface Outgoing {
  utteranceId: string;
  createdAt: number;
  text: string | null | undefined;
  textSent: boolean;
  chunks: string[] | null;
  mimeType: string | null;
  ackedChunks: number;
  audioComplete: boolean;
}

interface Incoming {
  item: VoiceMessagesItem;
  receivedAt: number;
}

interface ActiveCall {
  serverId: string;
  callId: string;
  transport: VoiceMessagesTransport;
  language: string;
  lastSeq: number;
  greet: boolean;
  hostStarted: boolean;
  generation: number;
  unsubscribe: Array<() => void>;
  syncTimer: ReturnType<typeof setInterval> | null;
}

const INITIAL_SNAPSHOT: VoiceMessagesSnapshot = {
  active: false,
  serverId: null,
  callId: null,
  phase: "idle",
  connected: false,
  pendingSends: 0,
  isMuted: false,
  lastHeard: null,
  lastSpoken: null,
};

function pcmSource(audio: PcmAudio) {
  return {
    size: audio.pcm.byteLength,
    type: `audio/pcm;rate=${audio.sampleRate};bits=16`,
    async arrayBuffer() {
      return Uint8Array.from(audio.pcm).buffer;
    },
  };
}

function splitBase64Chunks(data: Uint8Array): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.byteLength; offset += UPLOAD_CHUNK_BYTES) {
    chunks.push(Buffer.from(data.subarray(offset, offset + UPLOAD_CHUNK_BYTES)).toString("base64"));
  }
  return chunks.length > 0 ? chunks : [""];
}

/** Lets a loop sleep until new work arrives; a wake while the loop is busy is kept, not lost. */
class Wakeup {
  private pending: (() => void) | null = null;
  private missed = false;

  wake(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) pending();
    else this.missed = true;
  }

  wait(ms: number): Promise<void> {
    if (this.missed) {
      this.missed = false;
      return Promise.resolve();
    }
    let cancelTimer = () => {};
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancelTimer = () => clearTimeout(timer);
    });
    const woken = new Promise<void>((resolve) => {
      this.pending = resolve;
    });
    return Promise.race([timeout, woken]).finally(() => {
      cancelTimer();
      this.pending = null;
    });
  }
}

/**
 * Messages mode for a global voice call: store-and-forward instead of a live stream.
 * The phone cuts utterances locally, sends device text then compressed audio with
 * retries, and plays the host's numbered replies, falling back to a system voice when
 * the host's audio is late. A dropped connection only delays things; nothing is lost.
 */
export function createVoiceMessagesController(deps: VoiceMessagesControllerDeps) {
  const now = deps.now ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot: VoiceMessagesSnapshot = INITIAL_SNAPSHOT;
  let call: ActiveCall | null = null;
  let generation = 0;
  const vad = new EnergyVad();
  const outgoing: Outgoing[] = [];
  const incoming: Incoming[] = [];
  const handledSeqs = new Set<number>();
  const awaitingReplies = new Map<string, number>();
  let senderRunning = false;
  const senderWakeup = new Wakeup();
  let playerRunning = false;
  const playerWakeup = new Wakeup();
  let speaking = false;
  let bargeInMs = 0;
  let cueTimer: ReturnType<typeof setTimeout> | null = null;
  let cuePlaying = false;
  const cuePcm = Uint8Array.from(Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64"));

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function patch(next: Partial<VoiceMessagesSnapshot>): void {
    const merged = { ...snapshot, ...next };
    const changed = (Object.keys(merged) as Array<keyof VoiceMessagesSnapshot>).some(
      (key) => merged[key] !== snapshot[key],
    );
    if (!changed) return;
    snapshot = merged;
    emit();
  }

  function refreshPhase(): void {
    if (!call) {
      patch({ phase: "idle", pendingSends: 0 });
      return;
    }
    let phase: VoiceMessagesPhase = "listening";
    if (speaking) phase = "speaking";
    else if (vad.isInSpeech) phase = "recording";
    else if (outgoing.length > 0 || hasAwaitedReplies()) phase = "waiting";
    patch({ phase, pendingSends: outgoing.length });
    reconcileCue();
  }

  function hasAwaitedReplies(): boolean {
    const at = now();
    for (const [utteranceId, sentAt] of awaitingReplies) {
      if (at - sentAt > REPLY_WAIT_MAX_MS) {
        awaitingReplies.delete(utteranceId);
        deps.log("reply_wait_expired", { utteranceId });
      }
    }
    return awaitingReplies.size > 0;
  }

  function isCurrent(active: ActiveCall): boolean {
    return call === active && active.generation === generation;
  }

  // MARK: thinking cue

  function reconcileCue(): void {
    const shouldPlay = snapshot.phase === "waiting" && !speaking && incoming.length === 0;
    if (!shouldPlay) {
      if (cueTimer) clearTimeout(cueTimer);
      cueTimer = null;
      if (cuePlaying) {
        cuePlaying = false;
        deps.engine.stop();
        deps.engine.clearQueue();
      }
      return;
    }
    if (cueTimer || cuePlaying) return;
    cueTimer = setTimeout(() => {
      cueTimer = null;
      if (snapshot.phase !== "waiting" || speaking) return;
      cuePlaying = true;
      void deps.engine
        .play(pcmSource({ pcm: cuePcm, sampleRate: 16000 }))
        .catch(() => undefined)
        .finally(() => {
          if (!cuePlaying) return;
          cuePlaying = false;
          cueTimer = setTimeout(() => {
            cueTimer = null;
            reconcileCue();
          }, THINKING_TONE_NATIVE_PCM_DURATION_MS / 3);
        });
    }, CUE_GAP_MS);
  }

  function stopCue(): void {
    if (cueTimer) clearTimeout(cueTimer);
    cueTimer = null;
    if (cuePlaying) {
      cuePlaying = false;
      deps.engine.stop();
      deps.engine.clearQueue();
    }
  }

  // MARK: capture

  function handleCapturePcm(pcm: Uint8Array): void {
    if (!call || snapshot.isMuted) return;
    if (speaking) {
      const rms = pcm16Rms(pcm);
      const loud = rms >= Math.max(BARGE_IN_MIN_RMS, vad.threshold() * 4);
      bargeInMs = loud ? bargeInMs + (pcm.byteLength / 2 / VAD_SAMPLE_RATE) * 1000 : 0;
      if (bargeInMs < BARGE_IN_MS) return;
      deps.log("barge_in");
      interrupt();
    }
    for (const event of vad.push(pcm)) {
      if (event.type === "speech_started") {
        stopCue();
        refreshPhase();
      } else if (event.type === "utterance") {
        queueUtterance({ pcm: event.pcm, sampleRate: VAD_SAMPLE_RATE }, event.durationMs);
      } else {
        refreshPhase();
      }
    }
  }

  function queueUtterance(audio: PcmAudio, durationMs: number): void {
    const active = call;
    if (!active) return;
    const entry: Outgoing = {
      utteranceId: deps.createId(),
      createdAt: now(),
      text: undefined,
      textSent: false,
      chunks: null,
      mimeType: null,
      ackedChunks: 0,
      audioComplete: false,
    };
    outgoing.push(entry);
    awaitingReplies.set(entry.utteranceId, now());
    deps.log("utterance_captured", {
      utteranceId: entry.utteranceId,
      durationMs: Math.round(durationMs),
    });
    refreshPhase();
    void (async () => {
      const text = await deps.speech.transcribe(audio, active.language).catch(() => null);
      entry.text = text?.trim() || null;
      wakeSender();
    })();
    void (async () => {
      const compressed = await deps.speech.compress(audio);
      entry.chunks = splitBase64Chunks(compressed.data);
      entry.mimeType = compressed.mimeType;
      deps.log("utterance_compressed", {
        utteranceId: entry.utteranceId,
        bytes: compressed.data.byteLength,
        mimeType: compressed.mimeType,
      });
      wakeSender();
    })();
    wakeSender();
  }

  // MARK: sending

  function wakeSender(): void {
    senderWakeup.wake();
    if (!senderRunning) void runSender();
  }

  async function runSender(): Promise<void> {
    senderRunning = true;
    let retryDelay = 1_000;
    try {
      for (;;) {
        const active = call;
        const entry = outgoing[0];
        if (!active || !entry) break;
        if (now() - entry.createdAt > OUTGOING_MAX_AGE_MS) {
          deps.log("utterance_abandoned", { utteranceId: entry.utteranceId });
          outgoing.shift();
          awaitingReplies.delete(entry.utteranceId);
          refreshPhase();
          continue;
        }
        if (!active.transport.isConnected()) {
          await senderWakeup.wait(MAX_RETRY_DELAY_MS);
          continue;
        }
        try {
          const progressed = await sendNextPart(active, entry);
          if (!isCurrent(active)) continue;
          retryDelay = 1_000;
          if (entry.audioComplete) {
            outgoing.shift();
            refreshPhase();
            continue;
          }
          if (!progressed) await senderWakeup.wait(TEXT_WAIT_MS);
        } catch (error) {
          if (!isCurrent(active)) return;
          deps.log("send_retry", {
            utteranceId: entry.utteranceId,
            error: error instanceof Error ? error.message : String(error),
            retryInMs: retryDelay,
          });
          await senderWakeup.wait(retryDelay);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        }
      }
    } finally {
      senderRunning = false;
    }
  }

  /** Sends one part; returns false when there is nothing to send yet. */
  async function sendNextPart(active: ActiveCall, entry: Outgoing): Promise<boolean> {
    const textReady = typeof entry.text === "string";
    const textWaitOver = entry.text !== undefined || now() - entry.createdAt > TEXT_WAIT_MS;
    if (textReady && !entry.textSent) {
      await send(active, { utteranceId: entry.utteranceId, text: entry.text as string });
      entry.textSent = true;
      deps.log("utterance_text_sent", { utteranceId: entry.utteranceId });
      return true;
    }
    if (!entry.chunks || !entry.mimeType || !textWaitOver) return false;
    const index = entry.ackedChunks;
    const result = await send(active, {
      utteranceId: entry.utteranceId,
      chunkIndex: index,
      chunkCount: entry.chunks.length,
      audio: entry.chunks[index],
      mimeType: entry.mimeType,
    });
    entry.ackedChunks = Math.max(entry.ackedChunks + 1, result.receivedChunks);
    if (result.audioComplete || entry.ackedChunks >= entry.chunks.length) {
      entry.audioComplete = true;
      deps.log("utterance_audio_sent", {
        utteranceId: entry.utteranceId,
        chunks: entry.chunks.length,
      });
    }
    return true;
  }

  /** The call can start offline (that is when it's needed most); the host learns about it later. */
  async function ensureHostStarted(active: ActiveCall): Promise<void> {
    if (active.hostStarted) return;
    await startOnHost(active, active.greet);
  }

  /**
   * A host that lost the call (restart, idle sweep) recreates it with numbering from 1, so
   * the phone's sequence state resets with it; otherwise the next replies would be skipped.
   */
  async function startOnHost(active: ActiveCall, greet: boolean): Promise<void> {
    const started = await active.transport.start({ callId: active.callId, greet });
    if (!isCurrent(active)) return;
    const wasStarted = active.hostStarted;
    active.hostStarted = true;
    if (started.language) active.language = started.language;
    if (started.lastSeq < active.lastSeq) {
      active.lastSeq = started.lastSeq;
      handledSeqs.clear();
      awaitingReplies.clear();
      refreshPhase();
    }
    deps.log(wasStarted ? "host_call_resumed" : "host_call_started", {
      callId: active.callId,
      lastSeq: started.lastSeq,
    });
  }

  async function send(
    active: ActiveCall,
    part: Omit<Parameters<VoiceMessagesTransport["sendUtterance"]>[0], "callId">,
  ) {
    await ensureHostStarted(active);
    const result = await active.transport.sendUtterance({ callId: active.callId, ...part });
    if (result.error === "call_not_found") {
      // The host restarted or dropped the call: resume it under the same id, then retry.
      await startOnHost(active, false);
      throw new Error("call_not_found");
    }
    if (result.error) throw new Error(result.error);
    return result;
  }

  // MARK: receiving

  function handleItems(active: ActiveCall, items: VoiceMessagesItem[]): void {
    if (!isCurrent(active)) return;
    for (const item of [...items].sort((left, right) => left.seq - right.seq)) {
      const queued = incoming.find((entry) => entry.item.seq === item.seq);
      if (queued) {
        queued.item = item;
        continue;
      }
      if (handledSeqs.has(item.seq)) continue;
      handledSeqs.add(item.seq);
      active.lastSeq = Math.max(active.lastSeq, item.seq);
      if (item.utteranceId && item.kind !== "heard") awaitingReplies.delete(item.utteranceId);
      if (item.kind === "heard") {
        patch({ lastHeard: item.text });
        continue;
      }
      incoming.push({ item, receivedAt: now() });
    }
    refreshPhase();
    wakePlayer();
  }

  async function syncOnce(active: ActiveCall): Promise<void> {
    refreshPhase();
    if (!active.transport.isConnected()) return;
    try {
      await ensureHostStarted(active);
      const result = await active.transport.sync({
        callId: active.callId,
        afterSeq: active.lastSeq,
      });
      if (!isCurrent(active)) return;
      if (!result.active) {
        await startOnHost(active, false);
        return;
      }
      handleItems(active, result.items);
    } catch (error) {
      deps.log("sync_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // MARK: playback

  function wakePlayer(): void {
    playerWakeup.wake();
    if (!playerRunning) void runPlayer();
  }

  async function runPlayer(): Promise<void> {
    playerRunning = true;
    try {
      for (;;) {
        const active = call;
        const entry = incoming[0];
        if (!active || !entry) break;
        try {
          const audio = await resolveSpeech(active, entry);
          if (!isCurrent(active)) continue;
          incoming.shift();
          if (audio) await speak(entry.item.text, audio);
        } catch (error) {
          if (incoming[0] === entry) incoming.shift();
          deps.log("reply_playback_failed", {
            seq: entry.item.seq,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        refreshPhase();
      }
    } finally {
      playerRunning = false;
      if (call && incoming.length > 0) void runPlayer();
    }
  }

  async function resolveSpeech(active: ActiveCall, entry: Incoming): Promise<PcmAudio | null> {
    const { item } = entry;
    if (item.kind === "status") {
      const key: VoiceMessagesPhraseKey = item.code === "not_heard" ? "notHeard" : "backendFailed";
      return synthesizeLocally(deps.phrase(key, active.language), active.language);
    }
    while (!entry.item.audio && now() - entry.receivedAt < AUDIO_WAIT_MS && isCurrent(active)) {
      await playerWakeup.wait(AUDIO_WAIT_MS - (now() - entry.receivedAt));
    }
    if (entry.item.audio) {
      const hostAudio = await downloadHostAudio(active, entry);
      if (hostAudio) return hostAudio;
    }
    deps.log("reply_system_voice", { seq: item.seq, hadAudio: Boolean(entry.item.audio) });
    return synthesizeLocally(item.text, active.language);
  }

  async function synthesizeLocally(text: string, language: string): Promise<PcmAudio | null> {
    const rendered = await deps.speech.synthesize(text, language);
    if (rendered) return rendered;
    if (deps.speech.speakDirect) {
      speaking = true;
      patch({ lastSpoken: text });
      refreshPhase();
      await deps.speech.speakDirect(text, language);
      speaking = false;
    }
    return null;
  }

  async function downloadHostAudio(active: ActiveCall, entry: Incoming): Promise<PcmAudio | null> {
    const info = entry.item.audio;
    if (!info) return null;
    const parts: Uint8Array[] = [];
    let offset = 0;
    let total = info.size;
    let mimeType = info.mimeType;
    try {
      while (offset < total) {
        if (now() - entry.receivedAt > AUDIO_WAIT_MS * 2) return null;
        const slice = await active.transport.getAudio({
          callId: active.callId,
          seq: entry.item.seq,
          offset,
          length: DOWNLOAD_CHUNK_BYTES,
        });
        if (!slice.audio) return null;
        const bytes = Uint8Array.from(Buffer.from(slice.audio, "base64"));
        if (bytes.byteLength === 0) return null;
        parts.push(bytes);
        offset += bytes.byteLength;
        total = slice.total;
        mimeType = slice.mimeType ?? mimeType;
      }
    } catch (error) {
      deps.log("reply_audio_download_failed", {
        seq: entry.item.seq,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const data = new Uint8Array(offset);
    let position = 0;
    for (const part of parts) {
      data.set(part, position);
      position += part.byteLength;
    }
    return deps.speech.decode({ data, mimeType });
  }

  async function speak(text: string, audio: PcmAudio): Promise<void> {
    stopCue();
    speaking = true;
    bargeInMs = 0;
    patch({ lastSpoken: text });
    refreshPhase();
    try {
      await deps.engine.play(pcmSource(audio));
    } catch {
      // Interrupted by barge-in or stop.
    } finally {
      speaking = false;
      refreshPhase();
    }
  }

  function interrupt(): void {
    if (!speaking) return;
    deps.engine.stop();
    deps.engine.clearQueue();
    speaking = false;
    bargeInMs = 0;
    refreshPhase();
  }

  // MARK: lifecycle

  async function start(params: {
    serverId: string;
    transport: VoiceMessagesTransport;
    language: string;
    greet: boolean;
    /** Said with the phone's own voice right away, e.g. why the call switched modes. */
    intro?: string;
    callId?: string;
  }): Promise<void> {
    await stop({ endOnHost: false });
    generation += 1;
    const active: ActiveCall = {
      serverId: params.serverId,
      callId: params.callId ?? deps.createId(),
      transport: params.transport,
      language: params.language,
      lastSeq: 0,
      greet: params.greet,
      hostStarted: false,
      generation,
      unsubscribe: [],
      syncTimer: null,
    };
    call = active;
    vad.reset();
    await deps.activateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    await deps.engine.initialize();
    await deps.engine.startCapture();
    active.unsubscribe.push(
      params.transport.subscribeUpdates((updateCallId, item) => {
        if (updateCallId === active.callId) handleItems(active, [item]);
      }),
      params.transport.subscribeConnection((connected) => {
        if (!isCurrent(active)) return;
        deps.log(connected ? "connection_restored" : "connection_lost");
        patch({ connected });
        if (connected) {
          void syncOnce(active);
          wakeSender();
        }
      }),
    );
    active.syncTimer = setInterval(() => void syncOnce(active), SYNC_INTERVAL_MS);
    deps.log("messages_call_started", { callId: active.callId, greet: params.greet });
    patch({
      active: true,
      serverId: params.serverId,
      callId: active.callId,
      connected: params.transport.isConnected(),
      isMuted: deps.engine.isMuted(),
      lastHeard: null,
      lastSpoken: null,
    });
    refreshPhase();
    if (params.intro) void speakLocally(active, params.intro);
    if (params.transport.isConnected()) {
      await ensureHostStarted(active).catch((error: unknown) => {
        deps.log("host_call_start_deferred", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  async function speakLocally(active: ActiveCall, text: string): Promise<void> {
    const audio = await synthesizeLocally(text, active.language);
    if (audio && isCurrent(active)) await speak(text, audio);
  }

  async function stop(options: { endOnHost?: boolean; handoff?: boolean } = {}): Promise<void> {
    const active = call;
    if (!active) return;
    call = null;
    generation += 1;
    for (const unsubscribe of active.unsubscribe) unsubscribe();
    if (active.syncTimer) clearInterval(active.syncTimer);
    outgoing.length = 0;
    incoming.length = 0;
    handledSeqs.clear();
    awaitingReplies.clear();
    vad.reset();
    stopCue();
    speaking = false;
    senderWakeup.wake();
    playerWakeup.wake();
    deps.engine.stop();
    deps.engine.clearQueue();
    await deps.engine.stopCapture().catch(() => undefined);
    await deps.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    if (options.endOnHost !== false && active.hostStarted) {
      await active.transport
        .end({ callId: active.callId, handoff: options.handoff ?? false })
        .catch(() => undefined);
    }
    deps.log("messages_call_ended", { callId: active.callId });
    snapshot = INITIAL_SNAPSHOT;
    emit();
  }

  function toggleMute(): void {
    const muted = deps.engine.toggleMute();
    if (muted) vad.reset();
    patch({ isMuted: muted });
    refreshPhase();
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): VoiceMessagesSnapshot {
      return snapshot;
    },
    isActive(): boolean {
      return call !== null;
    },
    handleCapturePcm,
    start,
    stop,
    toggleMute,
    interrupt,
  };
}

export type VoiceMessagesController = ReturnType<typeof createVoiceMessagesController>;
