import type { VoiceGlowActivity } from "@/components/global-voice/voice-glow-types";
import type { GlobalVoice } from "@/voice-chat/use-global-voice";

export type CallStatusKey =
  | "connecting"
  | "listening"
  | "recording"
  | "sending"
  | "offline"
  | "thinking"
  | "speaking"
  | "muted";

function resolveMessagesStatusKey(call: GlobalVoice): CallStatusKey {
  const { messages } = call;
  if (messages.isMuted) return "muted";
  if (messages.phase === "speaking") return "speaking";
  if (messages.phase === "recording") return "recording";
  if (!messages.connected && messages.pendingSends > 0) return "offline";
  if (messages.pendingSends > 0) return "sending";
  if (messages.phase === "waiting") return "thinking";
  return "listening";
}

export function resolveCallStatusKey(call: GlobalVoice): CallStatusKey {
  if (call.isStarting || call.isSwitching || call.phase === "starting") return "connecting";
  if (call.messages.active) return resolveMessagesStatusKey(call);
  if (call.phase === "playing") return "speaking";
  if (call.phase === "submitting" || call.phase === "waiting") return "thinking";
  if (call.isMuted) return "muted";
  return "listening";
}

export function resolveGlowActivity(statusKey: CallStatusKey): VoiceGlowActivity {
  if (statusKey === "connecting") return "connecting";
  if (statusKey === "thinking" || statusKey === "sending" || statusKey === "offline") {
    return "processing";
  }
  return "conversation";
}
