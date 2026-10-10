import { EventEmitter } from "node:events";
import type pino from "pino";
import { v4 } from "uuid";
import { WebSocket, type RawData } from "ws";

import type { StreamingTranscriptionSession } from "../../speech-provider.js";

export const ELEVENLABS_REALTIME_STT_MODEL = "scribe_v2_realtime";

const SAMPLE_RATE = 16000;
const CONNECT_TIMEOUT_MS = 10_000;
// Scribe recommends 0.1–1 s chunks; native clients send 32–128 ms buffers.
const MIN_SEND_BYTES = (SAMPLE_RATE * 2) / 10;

const ERROR_MESSAGE_TYPES = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "commit_throttled",
  "transcriber_error",
  "unaccepted_terms",
  "rate_limited",
  "input_error",
  "invalid_request",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
]);

export class ElevenLabsRealtimeError extends Error {
  constructor(
    public readonly messageType: string,
    detail: string,
  ) {
    super(`ElevenLabs realtime transcription failed (${messageType}): ${detail}`);
    this.name = "ElevenLabsRealtimeError";
  }
}

type PendingCommit = { kind: "segment"; segmentId: string } | { kind: "discard" };

interface ServerMessage {
  message_type?: unknown;
  text?: unknown;
  error?: unknown;
}

export function buildRealtimeUrl(params: {
  baseUrl: string;
  model: string;
  language?: string;
  keyterms?: readonly string[];
}): URL {
  const url = new URL("/v1/speech-to-text/realtime", params.baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("model_id", params.model);
  url.searchParams.set("audio_format", `pcm_${SAMPLE_RATE}`);
  url.searchParams.set("commit_strategy", "manual");
  if (params.language) {
    url.searchParams.set("language_code", params.language);
  }
  for (const keyterm of params.keyterms ?? []) {
    url.searchParams.append("keyterms", keyterm);
  }
  return url;
}

export function createElevenLabsRealtimeSession(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  language?: string;
  keyterms?: readonly string[];
  logger: pino.Logger;
}): StreamingTranscriptionSession {
  const emitter = new EventEmitter();
  const logger = params.logger.child({ provider: "elevenlabs", component: "stt-realtime" });

  let socket: WebSocket | null = null;
  let closedByUs = false;
  let segmentId = v4();
  let previousSegmentId: string | null = null;
  let segmentHasAudio = false;
  let unsent: Buffer[] = [];
  let unsentBytes = 0;
  // Scribe's committed_transcript carries no id; commits settle in the order they were sent.
  const pending: PendingCommit[] = [];

  function send(message: Record<string, unknown>): void {
    if (socket?.readyState !== WebSocket.OPEN) {
      emitter.emit("error", new Error("ElevenLabs realtime socket is not open"));
      return;
    }
    socket.send(JSON.stringify(message));
  }

  function flush(commit: boolean): void {
    const audio = unsentBytes > 0 ? Buffer.concat(unsent, unsentBytes) : Buffer.alloc(0);
    unsent = [];
    unsentBytes = 0;
    if (audio.length === 0 && !commit) return;
    send({
      message_type: "input_audio_chunk",
      audio_base_64: audio.toString("base64"),
      commit,
      sample_rate: SAMPLE_RATE,
    });
  }

  function rotateSegment(): string {
    const committedId = segmentId;
    emitter.emit("committed", { segmentId: committedId, previousSegmentId });
    previousSegmentId = committedId;
    segmentId = v4();
    segmentHasAudio = false;
    return committedId;
  }

  function emitFinal(id: string, text: string): void {
    emitter.emit("transcript", {
      segmentId: id,
      transcript: text,
      isFinal: true,
      language: params.language,
      isLowConfidence: text.length === 0,
    });
  }

  function handleMessage(raw: RawData): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw.toString()) as ServerMessage;
    } catch (error) {
      logger.warn({ err: error }, "Ignoring unparseable ElevenLabs realtime message");
      return;
    }
    const type = typeof message.message_type === "string" ? message.message_type : "";
    const text = typeof message.text === "string" ? message.text.trim() : "";

    if (type === "partial_transcript") {
      const settling = pending.find((commit) => commit.kind === "segment");
      emitter.emit("transcript", {
        segmentId: settling?.kind === "segment" ? settling.segmentId : segmentId,
        transcript: text,
        isFinal: false,
      });
      return;
    }
    if (type === "committed_transcript") {
      const commit = pending.shift();
      if (commit?.kind === "segment") {
        emitFinal(commit.segmentId, text);
        return;
      }
      if (commit?.kind === "discard") return;
      // Scribe commits on its own after ~36 s of uncommitted audio.
      emitFinal(rotateSegment(), text);
      return;
    }
    if (ERROR_MESSAGE_TYPES.has(type)) {
      const detail = typeof message.error === "string" ? message.error : type;
      emitter.emit("error", new ElevenLabsRealtimeError(type, detail));
    }
  }

  return {
    requiredSampleRate: SAMPLE_RATE,

    connect() {
      const url = buildRealtimeUrl(params);
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { "xi-api-key": params.apiKey } });
        socket = ws;
        let started = false;
        const timeout = setTimeout(() => {
          reject(new Error("Timed out connecting to ElevenLabs realtime transcription"));
          ws.terminate();
        }, CONNECT_TIMEOUT_MS);

        ws.on("message", (raw) => {
          if (!started) {
            const type = safeMessageType(raw);
            if (type === "session_started") {
              started = true;
              clearTimeout(timeout);
              resolve();
              return;
            }
            if (ERROR_MESSAGE_TYPES.has(type)) {
              clearTimeout(timeout);
              reject(new ElevenLabsRealtimeError(type, safeErrorDetail(raw) ?? type));
              return;
            }
          }
          handleMessage(raw);
        });
        ws.on("unexpected-response", (_req, res) => {
          clearTimeout(timeout);
          reject(
            new Error(
              `ElevenLabs realtime transcription rejected the connection (${res.statusCode})`,
            ),
          );
          ws.terminate();
        });
        ws.on("error", (error) => {
          clearTimeout(timeout);
          if (!started) {
            reject(error);
            return;
          }
          emitter.emit("error", error);
        });
        ws.on("close", (code, reason) => {
          clearTimeout(timeout);
          if (!started) {
            reject(new Error(`ElevenLabs realtime socket closed before starting (${code})`));
            return;
          }
          if (closedByUs) return;
          emitter.emit(
            "error",
            new Error(
              `ElevenLabs realtime socket closed unexpectedly (${code}${reason.length ? `: ${reason.toString()}` : ""})`,
            ),
          );
        });
      });
    },

    appendPcm16(chunk: Buffer) {
      if (chunk.length === 0) return;
      unsent.push(chunk);
      unsentBytes += chunk.length;
      segmentHasAudio = true;
      if (unsentBytes >= MIN_SEND_BYTES) {
        flush(false);
      }
    },

    commit() {
      if (!segmentHasAudio) {
        emitFinal(rotateSegment(), "");
        return;
      }
      flush(true);
      pending.push({ kind: "segment", segmentId: rotateSegment() });
    },

    clear() {
      if (!segmentHasAudio) return;
      // Audio already streamed can't be withdrawn, so settle it server-side and drop the text.
      flush(true);
      pending.push({ kind: "discard" });
      segmentId = v4();
      segmentHasAudio = false;
    },

    close() {
      closedByUs = true;
      unsent = [];
      unsentBytes = 0;
      pending.length = 0;
      socket?.close();
      socket = null;
    },

    on(event: string, handler: (...args: never[]) => void) {
      emitter.on(event, handler as (...args: unknown[]) => void);
      return undefined;
    },
  };
}

function safeMessageType(raw: RawData): string {
  try {
    const parsed = JSON.parse(raw.toString()) as ServerMessage;
    return typeof parsed.message_type === "string" ? parsed.message_type : "";
  } catch {
    return "";
  }
}

function safeErrorDetail(raw: RawData): string | null {
  try {
    const parsed = JSON.parse(raw.toString()) as ServerMessage;
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}
