import { Readable } from "node:stream";
import type pino from "pino";

import type { ReadAloudVoiceSettings } from "../../read-aloud/config.js";
import { synthesizeElevenLabsSpeech } from "../../read-aloud/elevenlabs.js";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";

export interface ElevenLabsTtsConfig {
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  model: string;
  voiceSettings: ReadAloudVoiceSettings;
}

export class ElevenLabsTTS implements TextToSpeechProvider {
  public readonly id = "elevenlabs" as const;
  private readonly config: ElevenLabsTtsConfig;

  constructor(config: ElevenLabsTtsConfig, parentLogger: pino.Logger) {
    this.config = config;
    parentLogger
      .child({ module: "speech", provider: "elevenlabs", component: "tts" })
      .info({ model: config.model, voiceId: config.voiceId }, "TTS (ElevenLabs) initialized");
  }

  public async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot synthesize empty text");
    }
    const { audio, format } = await synthesizeElevenLabsSpeech({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      voiceId: this.config.voiceId,
      model: this.config.model,
      text,
      voiceSettings: this.config.voiceSettings,
    });
    return { stream: Readable.from([audio]), format };
  }
}
