import { Buffer } from "buffer";
import { requireOptionalNativeModule } from "expo-modules-core";
import {
  pcmMimeType,
  type CompressedAudio,
  type DeviceSpeech,
  type PcmAudio,
} from "@/voice-chat/messages/device-speech-types";

interface PaseoSpeechModule {
  transcribe(pcmBase64: string, sampleRate: number, locale: string): Promise<string | null>;
  encodeAac(pcmBase64: string, sampleRate: number): Promise<{ base64: string; mimeType: string }>;
  decode(base64: string, mimeType: string): Promise<{ pcmBase64: string; sampleRate: number }>;
  synthesize(text: string, language: string): Promise<{ pcmBase64: string; sampleRate: number }>;
}

// Optional because an OTA JS update can land on a binary built before the module existed.
const speechModule = requireOptionalNativeModule<PaseoSpeechModule>("PaseoSpeech");

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

export function createDeviceSpeech(): DeviceSpeech {
  return {
    async transcribe(audio: PcmAudio, language: string) {
      if (!speechModule) return null;
      return speechModule
        .transcribe(toBase64(audio.pcm), audio.sampleRate, language)
        .catch(() => null);
    },
    async compress(audio: PcmAudio): Promise<CompressedAudio> {
      if (speechModule) {
        try {
          const encoded = await speechModule.encodeAac(toBase64(audio.pcm), audio.sampleRate);
          return { data: fromBase64(encoded.base64), mimeType: encoded.mimeType };
        } catch (error) {
          console.warn("[VoiceMessages] AAC encoding failed, sending PCM", error);
        }
      }
      return { data: audio.pcm, mimeType: pcmMimeType(audio.sampleRate) };
    },
    async decode(audio: CompressedAudio) {
      if (!speechModule) return null;
      try {
        const decoded = await speechModule.decode(toBase64(audio.data), audio.mimeType);
        return { pcm: fromBase64(decoded.pcmBase64), sampleRate: decoded.sampleRate };
      } catch (error) {
        console.warn("[VoiceMessages] Could not decode reply audio", error);
        return null;
      }
    },
    async synthesize(text: string, language: string) {
      if (!speechModule) return null;
      try {
        const rendered = await speechModule.synthesize(text, language);
        const pcm = fromBase64(rendered.pcmBase64);
        return pcm.byteLength > 0 ? { pcm, sampleRate: rendered.sampleRate } : null;
      } catch (error) {
        console.warn("[VoiceMessages] System voice failed", error);
        return null;
      }
    },
  };
}
