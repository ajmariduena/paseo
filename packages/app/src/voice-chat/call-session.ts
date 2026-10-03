import type { CallSessionHandlers } from "@/voice-chat/call-session-types";

export type { CallSessionHandlers };

export function isCallKitAvailable(): boolean {
  return false;
}

export async function startCallSession(
  _displayName: string,
  _handlers: CallSessionHandlers,
): Promise<void> {}

export async function endCallSession(): Promise<void> {}
