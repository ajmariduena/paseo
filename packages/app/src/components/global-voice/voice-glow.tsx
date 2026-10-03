import type { VoiceGlowProps } from "@/components/global-voice/voice-glow-types";

/** The glow is drawn with Skia, which the web build doesn't load. */
export function VoiceGlow(_props: VoiceGlowProps) {
  return null;
}
