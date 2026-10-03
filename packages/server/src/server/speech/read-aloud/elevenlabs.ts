import type { ReadAloudVoiceSettings } from "./config.js";

// PCM keeps playback on the existing native engine, which cannot decode MP3.
const OUTPUT_FORMAT = "pcm_24000";
const AUDIO_FORMAT = "pcm;rate=24000";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5_000;
// ElevenLabs rejects stitching with more than three previous requests.
const MAX_PREVIOUS_REQUEST_IDS = 3;

export interface ElevenLabsSpeechRequest {
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  model: string;
  text: string;
  voiceSettings: ReadAloudVoiceSettings;
  previousRequestIds?: readonly string[];
  /** ElevenLabs `output_format`, e.g. `mp3_22050_32`. Defaults to PCM for the native engine. */
  outputFormat?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ElevenLabsSpeechResult {
  audio: Buffer;
  format: string;
  requestId: string | null;
}

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

export async function synthesizeElevenLabsSpeech(
  request: ElevenLabsSpeechRequest,
): Promise<ElevenLabsSpeechResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const sleep = request.sleep ?? defaultSleep;
  const url = new URL(`/v1/text-to-speech/${encodeURIComponent(request.voiceId)}`, request.baseUrl);
  const outputFormat = request.outputFormat ?? OUTPUT_FORMAT;
  url.searchParams.set("output_format", outputFormat);
  const body = JSON.stringify(buildRequestBody(request));

  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": request.apiKey,
        "Content-Type": "application/json",
        Accept: outputFormat.startsWith("mp3")
          ? "audio/mpeg, application/json"
          : "audio/pcm, application/json",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) {
        throw new ElevenLabsError("ElevenLabs returned empty audio", response.status, null);
      }
      return {
        audio,
        format: outputFormat === OUTPUT_FORMAT ? AUDIO_FORMAT : describeOutputFormat(outputFormat),
        requestId: response.headers.get("request-id"),
      };
    }

    const error = await toElevenLabsError(response);
    if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
      throw error;
    }
    await sleep(resolveRetryDelayMs(response.headers.get("retry-after")));
  }
}

function describeOutputFormat(outputFormat: string): string {
  return outputFormat.startsWith("mp3") ? "mp3" : outputFormat;
}

function buildRequestBody(request: ElevenLabsSpeechRequest): Record<string, unknown> {
  const { speed, stability, similarityBoost, style } = request.voiceSettings;
  const voiceSettings = Object.fromEntries(
    Object.entries({ speed, stability, similarity_boost: similarityBoost, style }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const previousRequestIds = request.previousRequestIds?.slice(-MAX_PREVIOUS_REQUEST_IDS) ?? [];
  return {
    text: request.text,
    model_id: request.model,
    ...(Object.keys(voiceSettings).length > 0 ? { voice_settings: voiceSettings } : {}),
    ...(previousRequestIds.length > 0 ? { previous_request_ids: previousRequestIds } : {}),
  };
}

function isRetryable(error: ElevenLabsError): boolean {
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function resolveRetryDelayMs(retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

async function toElevenLabsError(response: Response): Promise<ElevenLabsError> {
  const { code, message } = parseErrorBody(await response.text().catch(() => ""));
  return new ElevenLabsError(describeError(response.status, code, message), response.status, code);
}

// Error bodies come in three shapes: {detail: {code, message}}, {detail: [...]} for
// validation errors, and the legacy {detail: {status, message}} / {status, message}.
function parseErrorBody(raw: string): { code: string | null; message: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: null, message: raw.trim() || null };
  }
  if (!isRecord(parsed)) return { code: null, message: null };
  const detail = parsed.detail ?? parsed;
  if (Array.isArray(detail)) {
    const first = detail.find(isRecord);
    return { code: "validation_error", message: readString(first?.msg) };
  }
  if (typeof detail === "string") return { code: null, message: detail };
  if (!isRecord(detail)) return { code: null, message: null };
  return {
    code: readString(detail.code) ?? readString(detail.status),
    message: readString(detail.message),
  };
}

function describeError(status: number, code: string | null, message: string | null): string {
  const suffix = message ? `: ${message}` : "";
  if (status === 402 || code === "quota_exceeded") {
    return `ElevenLabs account has no credits left${suffix}`;
  }
  if (status === 401 || status === 403) return `ElevenLabs rejected the API key${suffix}`;
  if (status === 404) return `ElevenLabs could not find the voice or model${suffix}`;
  if (status === 429) return `ElevenLabs is rate limiting requests${suffix}`;
  return `ElevenLabs request failed (HTTP ${status})${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
