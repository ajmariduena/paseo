import { create } from "zustand";

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
  /** True while one mode hands over to the other, so the call isn't treated as ended. */
  isSwitching: boolean;
  /** Start the next call in messages mode (the user's last manual choice in this app session). */
  preferMessages: boolean;
  setOrchestratorAgentId: (serverId: string, agentId: string) => void;
  setStarting: (isStarting: boolean) => void;
  setMinimized: (isMinimized: boolean) => void;
  setCall: (
    patch: Partial<
      Pick<GlobalVoiceState, "callServerId" | "mode" | "isAutoMode" | "liveTransport">
    >,
  ) => void;
  setSwitching: (isSwitching: boolean) => void;
  setPreferMessages: (preferMessages: boolean) => void;
}

export const useGlobalVoiceStore = create<GlobalVoiceState>((set) => ({
  orchestratorAgentIds: {},
  isStarting: false,
  isMinimized: false,
  callServerId: null,
  mode: "live",
  isAutoMode: false,
  liveTransport: null,
  isSwitching: false,
  preferMessages: false,
  setOrchestratorAgentId: (serverId, agentId) =>
    set((state) => ({
      orchestratorAgentIds: { ...state.orchestratorAgentIds, [serverId]: agentId },
    })),
  setStarting: (isStarting) => set({ isStarting }),
  setMinimized: (isMinimized) => set({ isMinimized }),
  setCall: (patch) => set(patch),
  setSwitching: (isSwitching) => set({ isSwitching }),
  setPreferMessages: (preferMessages) => set({ preferMessages }),
}));
