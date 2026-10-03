export type VoiceGlowActivity = "connecting" | "processing" | "conversation";

export interface VoiceGlowProps {
  activity: VoiceGlowActivity;
}
