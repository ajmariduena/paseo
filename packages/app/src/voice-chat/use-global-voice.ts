import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useTranslation } from "react-i18next";
import {
  useVoiceMessagesController,
  useVoiceMessagesSnapshot,
  useVoiceOptional,
  useVoiceRuntimeOptional,
} from "@/contexts/voice-context";
import { useToast } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { getLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { endCallSession, isCallKitAvailable, startCallSession } from "@/voice-chat/call-session";
import {
  logVoiceCallEvent,
  startVoiceCallEventLog,
  stopVoiceCallEventLog,
} from "@/voice-chat/call-event-log";
import { ConnectionQuality } from "@/voice-chat/connection-quality";
import { useGlobalVoiceStore, type GlobalVoiceMode } from "@/voice-chat/global-voice-store";
import { createHostVoiceMessagesTransport } from "@/voice-chat/messages/host-transport";
import type {
  VoiceMessagesController,
  VoiceMessagesSnapshot,
} from "@/voice-chat/messages/messages-controller";
import type { VoiceRuntime } from "@/voice/voice-runtime";

const CALL_DISPLAY_NAME = "Paseo";
const QUALITY_TICK_MS = 1_000;

function supportsVoiceOrchestrator(serverId: string): boolean {
  const serverInfo = useSessionStore.getState().getSession(serverId)?.serverInfo;
  return serverInfo?.features?.voiceOrchestrator === true;
}

function supportsVoiceMessages(serverId: string): boolean {
  const serverInfo = useSessionStore.getState().getSession(serverId)?.serverInfo;
  return serverInfo?.features?.voiceMessages === true;
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

// The host's voice language, learned when the call starts; the UI language is only a fallback.
const voiceLanguages = new Map<string, string>();

function callLanguage(serverId: string): string {
  return voiceLanguages.get(serverId) ?? i18n.language;
}

function spoken(key: "switchedToMessages" | "weakSignal", serverId: string): string {
  return i18n.t(`globalVoice.spoken.${key}`, { lng: callLanguage(serverId) });
}

interface CallDeps {
  runtime: VoiceRuntime;
  messages: VoiceMessagesController;
}

async function startMessages(
  deps: CallDeps,
  serverId: string,
  options: { greet: boolean; intro?: string },
): Promise<void> {
  await deps.messages.start({
    serverId,
    transport: createHostVoiceMessagesTransport({ serverId, language: callLanguage(serverId) }),
    language: callLanguage(serverId),
    greet: options.greet,
    ...(options.intro ? { intro: options.intro } : {}),
  });
}

/** Moves the call to the other mode; the CallKit call and the conversation carry over. */
async function switchMode(
  deps: CallDeps,
  target: GlobalVoiceMode,
  reason: "manual" | "auto",
): Promise<void> {
  const store = useGlobalVoiceStore.getState();
  const serverId = store.callServerId;
  if (!serverId || store.isSwitching || store.mode === target) return;
  store.setSwitching(true);
  logVoiceCallEvent("mode_switch", { from: store.mode, to: target, reason });
  try {
    if (target === "messages") {
      deps.runtime.handOffVoice();
      await startMessages(deps, serverId, {
        greet: false,
        intro: spoken(reason === "auto" ? "weakSignal" : "switchedToMessages", serverId),
      });
      store.setCall({ mode: "messages", isAutoMode: reason === "auto" });
      return;
    }
    const agentId = store.orchestratorAgentIds[serverId];
    if (!agentId) throw new Error("The voice assistant is not running on this host.");
    await deps.messages.stop({ handoff: true });
    try {
      await deps.runtime.startVoice(serverId, agentId);
      store.setCall({ mode: "live", isAutoMode: false });
    } catch (error) {
      logVoiceCallEvent("live_resume_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await startMessages(deps, serverId, { greet: false });
      store.setCall({ mode: "messages", isAutoMode: reason === "auto" });
    }
  } finally {
    useGlobalVoiceStore.getState().setSwitching(false);
  }
}

export interface GlobalVoice {
  isActive: boolean;
  isStarting: boolean;
  isMuted: boolean;
  phase: string;
  mode: GlobalVoiceMode;
  isAutoMode: boolean;
  isSwitching: boolean;
  messages: VoiceMessagesSnapshot;
  start: () => void;
  stop: () => void;
  toggleMute: () => void;
  setWeakSignalMode: (enabled: boolean) => void;
}

export function useGlobalVoice(): GlobalVoice {
  const voice = useVoiceOptional();
  const runtime = useVoiceRuntimeOptional();
  const messagesController = useVoiceMessagesController();
  const messages = useVoiceMessagesSnapshot();
  const toast = useToast();
  const { t, i18n: appI18n } = useTranslation();
  const isStarting = useGlobalVoiceStore((state) => state.isStarting);
  const isSwitching = useGlobalVoiceStore((state) => state.isSwitching);
  const mode = useGlobalVoiceStore((state) => state.mode);
  const isAutoMode = useGlobalVoiceStore((state) => state.isAutoMode);
  const orchestratorAgentIds = useGlobalVoiceStore((state) => state.orchestratorAgentIds);
  const activeServerId = voice?.activeServerId ?? null;
  const activeAgentId = voice?.activeAgentId ?? null;
  const isLiveActive =
    voice !== null &&
    voice.isVoiceMode &&
    activeServerId !== null &&
    activeAgentId !== null &&
    orchestratorAgentIds[activeServerId] === activeAgentId;
  const isActive = isLiveActive || messages.active;

  const depsRef = useRef<CallDeps | null>(null);
  depsRef.current =
    runtime && messagesController ? { runtime, messages: messagesController } : null;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const stop = useCallback(() => {
    void (async () => {
      const deps = depsRef.current;
      logVoiceCallEvent("call_ended", { mode: useGlobalVoiceStore.getState().mode });
      await deps?.messages.stop().catch(() => undefined);
      await voiceRef.current?.stopVoice().catch((error) => {
        console.error("[GlobalVoice] Failed to stop voice", error);
      });
      await endCallSession().catch((error) => {
        console.warn("[GlobalVoice] Failed to end the call", error);
      });
      stopVoiceCallEventLog();
      const store = useGlobalVoiceStore.getState();
      store.setMinimized(false);
      store.setCall({ callServerId: null, mode: "live", isAutoMode: false });
    })();
  }, []);

  const start = useCallback(() => {
    const store = useGlobalVoiceStore.getState();
    const deps = depsRef.current;
    if (!deps || store.isStarting) return;
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
        const { agentId, language } = await client.startVoiceOrchestrator({
          language: appI18n.language,
        });
        if (language) voiceLanguages.set(serverId, language);
        useGlobalVoiceStore.getState().setOrchestratorAgentId(serverId, agentId);
        if (isCallKitAvailable()) {
          callStarted = await startCallSession(CALL_DISPLAY_NAME, {
            onEndedBySystem: () => stop(),
            onMuteChanged: (muted) => {
              const current = depsRef.current;
              if (!current) return;
              if (current.messages.isActive()) {
                if (current.messages.getSnapshot().isMuted !== muted) current.messages.toggleMute();
                return;
              }
              const live = voiceRef.current;
              if (live && live.isMuted !== muted) live.toggleMute();
            },
          }).then(
            () => true,
            (error: unknown) => {
              console.warn("[GlobalVoice] CallKit unavailable, continuing without it", error);
              return false;
            },
          );
        }
        startVoiceCallEventLog(serverId);
        const useMessages =
          useGlobalVoiceStore.getState().preferMessages && supportsVoiceMessages(serverId);
        useGlobalVoiceStore.getState().setCall({
          callServerId: serverId,
          mode: useMessages ? "messages" : "live",
          isAutoMode: false,
        });
        logVoiceCallEvent("call_started", { mode: useMessages ? "messages" : "live" });
        if (useMessages) {
          await startMessages(deps, serverId, { greet: true });
        } else {
          await deps.runtime.startVoice(serverId, agentId);
        }
      } catch (error) {
        if (callStarted) await endCallSession().catch(() => undefined);
        stopVoiceCallEventLog();
        useGlobalVoiceStore.getState().setCall({ callServerId: null, mode: "live" });
        const message = error instanceof Error ? error.message : String(error);
        console.error("[GlobalVoice] Failed to start", error);
        toast.error(message);
      } finally {
        useGlobalVoiceStore.getState().setStarting(false);
      }
    })();
  }, [appI18n.language, stop, t, toast]);

  const toggleMute = useCallback(() => {
    const deps = depsRef.current;
    if (deps?.messages.isActive()) {
      deps.messages.toggleMute();
      return;
    }
    voiceRef.current?.toggleMute();
  }, []);

  const setWeakSignalMode = useCallback(
    (enabled: boolean) => {
      const store = useGlobalVoiceStore.getState();
      store.setPreferMessages(enabled);
      const deps = depsRef.current;
      const serverId = store.callServerId;
      if (!deps || !serverId) return;
      if (enabled && !supportsVoiceMessages(serverId)) {
        toast.error(t("globalVoice.messagesUnsupported"));
        return;
      }
      void switchMode(deps, enabled ? "messages" : "live", "manual").catch((error) => {
        console.error("[GlobalVoice] Failed to switch modes", error);
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [t, toast],
  );

  return {
    isActive,
    isStarting,
    isMuted: messages.active ? messages.isMuted : (voice?.isMuted ?? false),
    phase: voice?.phase ?? "disabled",
    mode,
    isAutoMode,
    isSwitching,
    messages,
    start,
    stop,
    toggleMute,
    setWeakSignalMode,
  };
}

/**
 * Runs once per app (mounted with the call surface): ends CallKit when the call ends,
 * logs the phone's side of the call, and switches modes automatically on a bad link.
 */
export function useGlobalVoiceSupervisor(call: GlobalVoice): void {
  const runtime = useVoiceRuntimeOptional();
  const messagesController = useVoiceMessagesController();
  const callServerId = useGlobalVoiceStore((state) => state.callServerId);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (call.isSwitching || call.isStarting) return;
    if (wasActiveRef.current && !call.isActive) {
      void endCallSession().catch(() => undefined);
      stopVoiceCallEventLog();
      useGlobalVoiceStore
        .getState()
        .setCall({ callServerId: null, mode: "live", isAutoMode: false });
    }
    wasActiveRef.current = call.isActive;
  }, [call.isActive, call.isStarting, call.isSwitching]);

  useEffect(() => {
    if (!call.isActive) return;
    const subscription = AppState.addEventListener("change", (state) => {
      logVoiceCallEvent("app_state", { state });
    });
    return () => subscription.remove();
  }, [call.isActive]);

  useEffect(() => {
    if (!call.isActive || !callServerId || !runtime || !messagesController) return;
    const deps: CallDeps = { runtime, messages: messagesController };
    if (!supportsVoiceMessages(callServerId)) return;
    const store = getHostRuntimeStore();
    const quality = new ConnectionQuality(isConnected(callServerId), Date.now());
    let lastConnected = isConnected(callServerId);
    let disconnectedAt: number | null = lastConnected ? null : Date.now();
    const unsubscribe = store.subscribe(callServerId, () => {
      const connected = isConnected(callServerId);
      if (connected === lastConnected) return;
      lastConnected = connected;
      quality.update(connected, Date.now());
      if (connected) {
        logVoiceCallEvent("host_reconnected", {
          offlineMs: disconnectedAt ? Date.now() - disconnectedAt : null,
        });
        disconnectedAt = null;
      } else {
        disconnectedAt = Date.now();
        logVoiceCallEvent("host_disconnected", { mode: useGlobalVoiceStore.getState().mode });
      }
    });
    const timer = setInterval(() => {
      const state = useGlobalVoiceStore.getState();
      if (state.isSwitching) return;
      const now = Date.now();
      if (state.mode === "live" && quality.shouldDegrade(now)) {
        quality.noteDegraded(now);
        void switchMode(deps, "messages", "auto").catch(() => undefined);
        return;
      }
      const snapshot = messagesController.getSnapshot();
      if (
        state.mode === "messages" &&
        state.isAutoMode &&
        snapshot.phase === "listening" &&
        snapshot.pendingSends === 0 &&
        quality.shouldRecover(now)
      ) {
        quality.noteRecovered(now);
        void switchMode(deps, "live", "auto").catch(() => undefined);
      }
    }, QUALITY_TICK_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [call.isActive, callServerId, messagesController, runtime]);
}
