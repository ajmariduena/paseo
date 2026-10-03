import {
  pcmMimeType,
  type CompressedAudio,
  type DeviceSpeech,
  type PcmAudio,
} from "@/voice-chat/messages/device-speech-types";

function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, Math.round(value * 32767), true);
  }
  return out;
}

export function createDeviceSpeech(): DeviceSpeech {
  return {
    async transcribe() {
      return null;
    },
    async compress(audio: PcmAudio): Promise<CompressedAudio> {
      return { data: audio.pcm, mimeType: pcmMimeType(audio.sampleRate) };
    },
    async decode(audio: CompressedAudio) {
      if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return null;
      const context = new window.AudioContext();
      try {
        const copy = audio.data.slice().buffer;
        const decoded = await context.decodeAudioData(copy);
        return { pcm: floatToPcm16(decoded.getChannelData(0)), sampleRate: decoded.sampleRate };
      } catch (error) {
        console.warn("[VoiceMessages] Could not decode reply audio", error);
        return null;
      } finally {
        void context.close();
      }
    },
    async synthesize() {
      return null;
    },
    async speakDirect(text: string, language: string) {
      if (typeof window === "undefined" || !window.speechSynthesis) return false;
      return new Promise<boolean>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = language;
        utterance.addEventListener("end", () => resolve(true));
        utterance.addEventListener("error", () => resolve(false));
        window.speechSynthesis.speak(utterance);
      });
    },
  };
}
