import type pino from "pino";
import type { Readable } from "node:stream";

export interface LogprobToken {
  token: string;
  logprob: number;
  bytes?: number[];
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  logprobs?: LogprobToken[];
  avgLogprob?: number;
  isLowConfidence?: boolean;
}

export interface StreamingTranscriptionCommittedEvent {
  segmentId: string;
  previousSegmentId: string | null;
}

export interface StreamingTranscriptionEvent {
  segmentId: string;
  transcript: string;
  isFinal: boolean;
  language?: string;
  logprobs?: LogprobToken[];
  avgLogprob?: number;
  isLowConfidence?: boolean;
}

export interface StreamingTranscriptionSession {
  /**
   * Required PCM16LE sample rate for `appendPcm16()`.
   * Callers are responsible for resampling before appending.
   */
  requiredSampleRate: number;

  connect(): Promise<void>;
  appendPcm16(pcm16le: Buffer): void;
  commit(): void;
  clear(): void;
  close(): void;

  on(event: "committed", handler: (payload: StreamingTranscriptionCommittedEvent) => void): unknown;
  on(event: "transcript", handler: (payload: StreamingTranscriptionEvent) => void): unknown;
  on(event: "error", handler: (err: unknown) => void): unknown;
}

export interface SpeechClip {
  audio: Buffer;
  /** e.g. `audio/mp4` (AAC), `audio/wav`, `audio/pcm;rate=16000`. */
  mimeType: string;
}

export interface SpeechToTextProvider {
  id: "openai" | "local" | (string & {});
  createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession;
  /** Transcribes a whole recorded clip in any container the provider accepts. */
  transcribeClip?(clip: SpeechClip, language?: string): Promise<TranscriptionResult>;
}

export interface SpeechStreamResult {
  stream: Readable;
  format: string;
}

export interface TextToSpeechProvider {
  synthesizeSpeech(text: string): Promise<SpeechStreamResult>;
  /** A small compressed clip for slow links, when the provider can produce one. */
  synthesizeCompressed?(text: string): Promise<SpeechClip>;
}
