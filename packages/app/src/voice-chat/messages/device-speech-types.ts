export interface PcmAudio {
  pcm: Uint8Array;
  sampleRate: number;
}

export interface CompressedAudio {
  data: Uint8Array;
  mimeType: string;
}

/** Speech work the phone does itself in messages mode, so only small payloads cross the network. */
export interface DeviceSpeech {
  /** On-device transcript, or null when the platform can't transcribe offline. */
  transcribe(audio: PcmAudio, language: string): Promise<string | null>;
  compress(audio: PcmAudio): Promise<CompressedAudio>;
  decode(audio: CompressedAudio): Promise<PcmAudio | null>;
  /** A system voice rendered to PCM, or null when the platform can't render offline. */
  synthesize(text: string, language: string): Promise<PcmAudio | null>;
  /** Speaks through the platform directly when it can't render to PCM (browsers). */
  speakDirect?(text: string, language: string): Promise<boolean>;
}

export function pcmMimeType(sampleRate: number): string {
  return `audio/pcm;rate=${sampleRate}`;
}
