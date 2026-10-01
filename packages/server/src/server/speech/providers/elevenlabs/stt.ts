import { EventEmitter } from "node:events";
import type pino from "pino";
import { v4 } from "uuid";

import { pcm16MonoToWav } from "../../audio.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  TranscriptionResult,
} from "../../speech-provider.js";

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

  public createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
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

  private async transcribe(
    pcm16: Buffer,
    language: string | undefined,
  ): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const form = new FormData();
    form.set("model_id", this.model);
    form.set("tag_audio_events", "false");
    if (language) {
      form.set("language_code", language);
    }
    form.set(
      "file",
      new Blob([new Uint8Array(pcm16MonoToWav(pcm16, SAMPLE_RATE))], { type: "audio/wav" }),
      "dictation.wav",
    );

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
