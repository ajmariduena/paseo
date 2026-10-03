import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import type { CallSessionHandlers } from "@/voice-chat/call-session-types";

export type { CallSessionHandlers };

interface PaseoCallModule {
  startCall(displayName: string): Promise<void>;
  endCall(): Promise<void>;
  isCallActive(): boolean;
  addListener(eventName: "onCallEnded", handler: () => void): EventSubscription;
  addListener(
    eventName: "onMuteChanged",
    handler: (event: { muted: boolean }) => void,
  ): EventSubscription;
}

// Optional because an OTA JS update can land on a binary built before the module existed.
const callModule = requireOptionalNativeModule<PaseoCallModule>("PaseoCall");

let subscriptions: EventSubscription[] = [];

function removeHandlers(): void {
  for (const subscription of subscriptions) {
    subscription.remove();
  }
  subscriptions = [];
}

export function isCallKitAvailable(): boolean {
  return callModule !== null;
}

export async function startCallSession(
  displayName: string,
  handlers: CallSessionHandlers,
): Promise<void> {
  if (!callModule) {
    return;
  }
  removeHandlers();
  if (callModule.isCallActive()) {
    await callModule.endCall();
  }
  subscriptions = [
    callModule.addListener("onCallEnded", () => {
      removeHandlers();
      handlers.onEndedBySystem();
    }),
    callModule.addListener("onMuteChanged", (event) => {
      handlers.onMuteChanged(event.muted);
    }),
  ];
  try {
    await callModule.startCall(displayName);
  } catch (error) {
    removeHandlers();
    throw error;
  }
}

export async function endCallSession(): Promise<void> {
  removeHandlers();
  if (!callModule) {
    return;
  }
  await callModule.endCall();
}
