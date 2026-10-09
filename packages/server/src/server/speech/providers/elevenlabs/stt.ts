import { EventEmitter } from "node:events";
import type pino from "pino";
import { v4 } from "uuid";

import { pcm16MonoToWav } from "../../audio.js";
import type {
  SpeechClip,
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  TranscriptionResult,
} from "../../speech-provider.js";
import {
  createElevenLabsRealtimeSession,
  ELEVENLABS_REALTIME_STT_MODEL,
} from "./realtime-stt-session.js";

export const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2";

const SAMPLE_RATE = 16000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface ElevenLabsSttConfig {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface ElevenLabsTranscriptionResponse {
  text?: unknown;
  language_code?: unknown;
}

export class ElevenLabsSTT implements SpeechToTextProvider {
  public readonly id = "elevenlabs" as const;
  private readonly config: ElevenLabsSttConfig;

  constructor(config: ElevenLabsSttConfig, parentLogger: pino.Logger) {
    this.config = config;
    parentLogger
      .child({ module: "speech", provider: "elevenlabs", component: "stt" })
      .info({ model: this.model }, "STT (ElevenLabs Scribe) initialized");
  }

  private get model(): string {
    return this.config.model ?? DEFAULT_ELEVENLABS_STT_MODEL;
  }

  private get batchModel(): string {
    return this.model === ELEVENLABS_REALTIME_STT_MODEL ? DEFAULT_ELEVENLABS_STT_MODEL : this.model;
  }

  public createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    if (this.model === ELEVENLABS_REALTIME_STT_MODEL) {
      return createElevenLabsRealtimeSession({
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
        model: this.model,
        language: params.language,
        logger: params.logger,
      });
    }
    const emitter = new EventEmitter();
    const logger = params.logger.child({ provider: "elevenlabs", component: "stt-session" });
    const transcribe = (pcm16: Buffer) => this.transcribe(pcm16, params.language);

    let connected = false;
    let segmentId = v4();
    let previousSegmentId: string | null = null;
    let pcm16: Buffer = Buffer.alloc(0);

    const emitTranscript = (committedId: string, result: TranscriptionResult) => {
      emitter.emit("transcript", {
        segmentId: committedId,
        transcript: result.text,
        isFinal: true,
        language: result.language,
        isLowConfidence: result.text.length === 0,
      });
    };

    return {
      requiredSampleRate: SAMPLE_RATE,
      async connect() {
        connected = true;
      },
      appendPcm16(chunk: Buffer) {
        if (!connected) {
          emitter.emit("error", new Error("STT session not connected"));
          return;
        }
        pcm16 = pcm16.length === 0 ? chunk : Buffer.concat([pcm16, chunk]);
      },
      commit() {
        if (!connected) {
          emitter.emit("error", new Error("STT session not connected"));
          return;
        }
        const committedId = segmentId;
        const audio = pcm16;
        emitter.emit("committed", { segmentId: committedId, previousSegmentId });
        previousSegmentId = committedId;
        segmentId = v4();
        pcm16 = Buffer.alloc(0);

        if (audio.length === 0) {
          emitTranscript(committedId, { text: "", language: params.language });
          return;
        }
        void transcribe(audio).then(
          (result) => emitTranscript(committedId, result),
          (error: unknown) => {
            logger.error({ err: error }, "ElevenLabs transcription failed");
            emitter.emit("error", error);
          },
        );
      },
      clear() {
        pcm16 = Buffer.alloc(0);
        segmentId = v4();
      },
      close() {
        connected = false;
        pcm16 = Buffer.alloc(0);
      },
      on(event: string, handler: (...args: never[]) => void) {
        emitter.on(event, handler as (...args: unknown[]) => void);
        return undefined;
      },
    };
  }

  public async transcribeClip(
    clip: SpeechClip,
    language?: string,
    options?: { keyterms?: readonly string[] },
  ): Promise<TranscriptionResult> {
    const keyterms = options?.keyterms ?? [];
    const pcmRate = /^audio\/pcm/i.test(clip.mimeType)
      ? Number(/rate=(\d+)/i.exec(clip.mimeType)?.[1] ?? SAMPLE_RATE)
      : null;
    if (pcmRate !== null) {
      return this.upload(
        new Blob([new Uint8Array(pcm16MonoToWav(clip.audio, pcmRate))], { type: "audio/wav" }),
        "clip.wav",
        language,
        keyterms,
      );
    }
    return this.upload(
      new Blob([new Uint8Array(clip.audio)], { type: clip.mimeType }),
      `clip.${clipExtension(clip.mimeType)}`,
      language,
      keyterms,
    );
  }

  private async transcribe(
    pcm16: Buffer,
    language: string | undefined,
  ): Promise<TranscriptionResult> {
    return this.upload(
      new Blob([new Uint8Array(pcm16MonoToWav(pcm16, SAMPLE_RATE))], { type: "audio/wav" }),
      "dictation.wav",
      language,
    );
  }

  private async upload(
    file: Blob,
    filename: string,
    language: string | undefined,
    keyterms: readonly string[] = [],
  ): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const form = new FormData();
    form.set("model_id", this.batchModel);
    form.set("tag_audio_events", "false");
    if (language) {
      form.set("language_code", language);
    }
    // Each keyterm is its own form field; Scribe bills 20% more when any are sent.
    for (const keyterm of keyterms) form.append("keyterms", keyterm);
    form.set("file", file, filename);

    const fetchImpl = this.config.fetchImpl ?? fetch;
    const response = await fetchImpl(new URL("/v1/speech-to-text", this.config.baseUrl), {
      method: "POST",
      headers: { "xi-api-key": this.config.apiKey },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs speech-to-text failed (${response.status}): ${detail.slice(0, 300)}`,
      );
    }
    const body = (await response.json()) as ElevenLabsTranscriptionResponse;
    return {
      text: typeof body.text === "string" ? body.text.trim() : "",
      language: typeof body.language_code === "string" ? body.language_code : language,
      duration: Date.now() - startedAt,
    };
  }
}

function clipExtension(mimeType: string): string {
  if (/mp4|m4a|aac/i.test(mimeType)) return "m4a";
  if (/mpeg|mp3/i.test(mimeType)) return "mp3";
  if (/ogg|opus/i.test(mimeType)) return "ogg";
  if (/webm/i.test(mimeType)) return "webm";
  return "wav";
}
