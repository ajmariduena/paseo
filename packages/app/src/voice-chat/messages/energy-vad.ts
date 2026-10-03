export const VAD_SAMPLE_RATE = 16000;
const BYTES_PER_MS = (VAD_SAMPLE_RATE * 2) / 1000;

export interface EnergyVadOptions {
  /** Speech must stay above the threshold this long to start an utterance. */
  startMs: number;
  /** Silence this long ends the utterance. */
  endSilenceMs: number;
  /** Audio kept from before the start so the first syllable isn't clipped. */
  preRollMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  minThreshold: number;
  /** Speech threshold as a multiple of the tracked noise floor. */
  floorMultiplier: number;
}

export const DEFAULT_ENERGY_VAD_OPTIONS: EnergyVadOptions = {
  startMs: 200,
  endSilenceMs: 1200,
  preRollMs: 350,
  minSpeechMs: 450,
  maxUtteranceMs: 60_000,
  minThreshold: 0.02,
  floorMultiplier: 3,
};

export type EnergyVadEvent =
  | { type: "speech_started" }
  | { type: "utterance"; pcm: Uint8Array; durationMs: number }
  | { type: "discarded" };

export function pcm16Rms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = view.getInt16(index * 2, true) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Cuts 16 kHz PCM16 microphone audio into utterances with an adaptive energy threshold.
 * The call audio already runs through iOS voice processing (echo cancellation, noise
 * suppression), so energy is a usable speech signal without a model on the phone.
 */
export class EnergyVad {
  private readonly options: EnergyVadOptions;
  private noiseFloor = 0.005;
  private preRoll: Uint8Array[] = [];
  private preRollBytes = 0;
  private candidate: Uint8Array[] = [];
  private candidateMs = 0;
  private speech: Uint8Array[] = [];
  private speechMs = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private inSpeech = false;

  constructor(options: Partial<EnergyVadOptions> = {}) {
    this.options = { ...DEFAULT_ENERGY_VAD_OPTIONS, ...options };
  }

  get isInSpeech(): boolean {
    return this.inSpeech;
  }

  threshold(): number {
    return Math.max(this.options.minThreshold, this.noiseFloor * this.options.floorMultiplier);
  }

  reset(): void {
    this.preRoll = [];
    this.preRollBytes = 0;
    this.candidate = [];
    this.candidateMs = 0;
    this.speech = [];
    this.speechMs = 0;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.inSpeech = false;
  }

  push(pcm: Uint8Array): EnergyVadEvent[] {
    const durationMs = pcm.byteLength / BYTES_PER_MS;
    if (durationMs <= 0) return [];
    const rms = pcm16Rms(pcm);
    const threshold = this.threshold();
    // Hysteresis: once talking, softer syllables still count as speech.
    return this.inSpeech
      ? this.pushInSpeech(pcm, durationMs, rms >= threshold * 0.7)
      : this.pushIdle(pcm, durationMs, rms, rms >= threshold);
  }

  private pushIdle(
    pcm: Uint8Array,
    durationMs: number,
    rms: number,
    voiced: boolean,
  ): EnergyVadEvent[] {
    if (!voiced) {
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      this.preRoll.push(...this.candidate, pcm);
      this.preRollBytes +=
        this.candidate.reduce((sum, chunk) => sum + chunk.byteLength, 0) + pcm.byteLength;
      this.candidate = [];
      this.candidateMs = 0;
      this.trimPreRoll();
      return [];
    }
    this.candidate.push(pcm);
    this.candidateMs += durationMs;
    if (this.candidateMs < this.options.startMs) return [];
    this.inSpeech = true;
    this.speech = [...this.preRoll, ...this.candidate];
    this.speechMs = this.speech.reduce((sum, chunk) => sum + chunk.byteLength, 0) / BYTES_PER_MS;
    this.voicedMs = this.candidateMs;
    this.silenceMs = 0;
    this.preRoll = [];
    this.preRollBytes = 0;
    this.candidate = [];
    this.candidateMs = 0;
    return [{ type: "speech_started" }];
  }

  private pushInSpeech(pcm: Uint8Array, durationMs: number, voiced: boolean): EnergyVadEvent[] {
    this.speech.push(pcm);
    this.speechMs += durationMs;
    if (voiced) {
      this.voicedMs += durationMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += durationMs;
    }
    if (this.silenceMs < this.options.endSilenceMs && this.speechMs < this.options.maxUtteranceMs) {
      return [];
    }
    const event: EnergyVadEvent =
      this.voicedMs >= this.options.minSpeechMs
        ? { type: "utterance", pcm: concat(this.speech), durationMs: this.speechMs }
        : { type: "discarded" };
    this.reset();
    return [event];
  }

  private trimPreRoll(): void {
    const maxBytes = this.options.preRollMs * BYTES_PER_MS;
    while (this.preRollBytes > maxBytes && this.preRoll.length > 1) {
      const dropped = this.preRoll.shift();
      this.preRollBytes -= dropped?.byteLength ?? 0;
    }
  }
}
