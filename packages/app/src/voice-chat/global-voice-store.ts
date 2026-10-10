import { create } from "zustand";
import type { OnTheGoOverride, OnTheGoReason } from "@/voice-chat/on-the-go/on-the-go-detector";

export type GlobalVoiceMode = "live" | "messages";

interface GlobalVoiceState {
  /** The orchestrator agent each host answered with, so the UI can tell a global call from per-agent voice. */
  orchestratorAgentIds: Record<string, string>;
  isStarting: boolean;
  isMinimized: boolean;
  /** The host the current call talks to, in either mode. */
  callServerId: string | null;
  mode: GlobalVoiceMode;
  /** Set when the app chose messages mode itself; the user's own choice is never undone automatically. */
  isAutoMode: boolean;
  /** How live audio travels: straight to GPT-Live over WebRTC, or relayed through the host. */
  liveTransport: "webrtc" | "relay" | null;
  /** The call's mute, applied to whichever mode is running. */
  isMuted: boolean;
  /** True while one mode hands over to the other, so the call isn't treated as ended. */
  isSwitching: boolean;
  /** Start the next call in messages mode (the user's last manual choice in this app session). */
  preferMessages: boolean;
  /** The driving layout of the call screen, on while the phone is in a car. */
  onTheGo: boolean;
  onTheGoReason: OnTheGoReason | null;
  /** The user's choice for this call; cleared at hang-up. */
  onTheGoOverride: OnTheGoOverride;
  setOrchestratorAgentId: (serverId: string, agentId: string) => void;
  setStarting: (isStarting: boolean) => void;
  setMinimized: (isMinimized: boolean) => void;
  setCall: (
    patch: Partial<
      Pick<GlobalVoiceState, "callServerId" | "mode" | "isAutoMode" | "liveTransport" | "isMuted">
    >,
  ) => void;
  setSwitching: (isSwitching: boolean) => void;
  setPreferMessages: (preferMessages: boolean) => void;
  setOnTheGo: (
    patch: Partial<Pick<GlobalVoiceState, "onTheGo" | "onTheGoReason" | "onTheGoOverride">>,
  ) => void;
}

export const useGlobalVoiceStore = create<GlobalVoiceState>((set) => ({
  orchestratorAgentIds: {},
  isStarting: false,
  isMinimized: false,
  callServerId: null,
  mode: "live",
  isAutoMode: false,
  liveTransport: null,
  isMuted: false,
  isSwitching: false,
  preferMessages: false,
  onTheGo: false,
  onTheGoReason: null,
  onTheGoOverride: null,
  setOrchestratorAgentId: (serverId, agentId) =>
    set((state) => ({
      orchestratorAgentIds: { ...state.orchestratorAgentIds, [serverId]: agentId },
    })),
  setStarting: (isStarting) => set({ isStarting }),
  setMinimized: (isMinimized) => set({ isMinimized }),
  setCall: (patch) => set(patch),
  setSwitching: (isSwitching) => set({ isSwitching }),
  setPreferMessages: (preferMessages) => set({ preferMessages }),
  setOnTheGo: (patch) => set(patch),
}));
