import { create } from "zustand";

interface GlobalVoiceState {
  /** The orchestrator agent each host answered with, so the UI can tell a global call from per-agent voice. */
  orchestratorAgentIds: Record<string, string>;
  isStarting: boolean;
  isMinimized: boolean;
  setOrchestratorAgentId: (serverId: string, agentId: string) => void;
  setStarting: (isStarting: boolean) => void;
  setMinimized: (isMinimized: boolean) => void;
}

export const useGlobalVoiceStore = create<GlobalVoiceState>((set) => ({
  orchestratorAgentIds: {},
  isStarting: false,
  isMinimized: false,
  setOrchestratorAgentId: (serverId, agentId) =>
    set((state) => ({
      orchestratorAgentIds: { ...state.orchestratorAgentIds, [serverId]: agentId },
    })),
  setStarting: (isStarting) => set({ isStarting }),
  setMinimized: (isMinimized) => set({ isMinimized }),
}));
