import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceOptional } from "@/contexts/voice-context";
import { useToast } from "@/contexts/toast-api-context";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { getLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { endCallSession, isCallKitAvailable, startCallSession } from "@/voice-chat/call-session";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";

const CALL_DISPLAY_NAME = "Paseo";

function supportsVoiceOrchestrator(serverId: string): boolean {
  const serverInfo = useSessionStore.getState().getSession(serverId)?.serverInfo;
  return serverInfo?.features?.voiceOrchestrator === true;
}

function isConnected(serverId: string): boolean {
  return isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId));
}

function resolveTargetServerId(): string | null {
  const active = getLastWorkspaceSelection()?.serverId ?? null;
  if (active && isConnected(active) && supportsVoiceOrchestrator(active)) return active;
  for (const host of getHostRuntimeStore().getHosts()) {
    if (isConnected(host.serverId) && supportsVoiceOrchestrator(host.serverId)) {
      return host.serverId;
    }
  }
  return null;
}

export interface GlobalVoice {
  isActive: boolean;
  isStarting: boolean;
  isMuted: boolean;
  phase: string;
  start: () => void;
  stop: () => void;
  toggleMute: () => void;
}

export function useGlobalVoice(): GlobalVoice {
  const voice = useVoiceOptional();
  const toast = useToast();
  const { t, i18n } = useTranslation();
  const isStarting = useGlobalVoiceStore((state) => state.isStarting);
  const orchestratorAgentIds = useGlobalVoiceStore((state) => state.orchestratorAgentIds);
  const activeServerId = voice?.activeServerId ?? null;
  const activeAgentId = voice?.activeAgentId ?? null;
  const isActive =
    voice !== null &&
    voice.isVoiceMode &&
    activeServerId !== null &&
    activeAgentId !== null &&
    orchestratorAgentIds[activeServerId] === activeAgentId;

  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const stop = useCallback(() => {
    void (async () => {
      await voiceRef.current?.stopVoice().catch((error) => {
        console.error("[GlobalVoice] Failed to stop voice", error);
      });
      await endCallSession().catch((error) => {
        console.warn("[GlobalVoice] Failed to end the call", error);
      });
      useGlobalVoiceStore.getState().setMinimized(false);
    })();
  }, []);

  const start = useCallback(() => {
    const store = useGlobalVoiceStore.getState();
    const runtime = voiceRef.current;
    if (!runtime || store.isStarting) return;
    const serverId = resolveTargetServerId();
    const client = serverId ? getHostRuntimeStore().getClient(serverId) : null;
    if (!serverId || !client) {
      toast.error(t("globalVoice.unsupported"));
      return;
    }
    store.setStarting(true);
    store.setMinimized(false);
    void (async () => {
      let callStarted = false;
      try {
        const { agentId } = await client.startVoiceOrchestrator({ language: i18n.language });
        useGlobalVoiceStore.getState().setOrchestratorAgentId(serverId, agentId);
        if (isCallKitAvailable()) {
          callStarted = await startCallSession(CALL_DISPLAY_NAME, {
            onEndedBySystem: () => {
              void voiceRef.current?.stopVoice().catch(() => undefined);
            },
            onMuteChanged: (muted) => {
              const current = voiceRef.current;
              if (current && current.isMuted !== muted) current.toggleMute();
            },
          }).then(
            () => true,
            (error: unknown) => {
              console.warn("[GlobalVoice] CallKit unavailable, continuing without it", error);
              return false;
            },
          );
        }
        await runtime.startVoice(serverId, agentId);
      } catch (error) {
        if (callStarted) await endCallSession().catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        console.error("[GlobalVoice] Failed to start", error);
        toast.error(message);
      } finally {
        useGlobalVoiceStore.getState().setStarting(false);
      }
    })();
  }, [i18n.language, t, toast]);

  const toggleMute = useCallback(() => {
    voiceRef.current?.toggleMute();
  }, []);

  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (wasActiveRef.current && !isActive && !isStarting) {
      void endCallSession().catch(() => undefined);
    }
    wasActiveRef.current = isActive;
  }, [isActive, isStarting]);

  return {
    isActive,
    isStarting,
    isMuted: voice?.isMuted ?? false,
    phase: voice?.phase ?? "disabled",
    start,
    stop,
    toggleMute,
  };
}
