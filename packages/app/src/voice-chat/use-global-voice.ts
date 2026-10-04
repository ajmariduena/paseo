import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useTranslation } from "react-i18next";
import {
  useLiveWebrtcController,
  useLiveWebrtcSnapshot,
  useVoiceMessagesController,
  useVoiceMessagesSnapshot,
  useVoiceOptional,
  useVoiceRuntimeOptional,
} from "@/contexts/voice-context";
import { useToast } from "@/contexts/toast-api-context";
import { createAgentPreferencesService } from "@/create-agent-preferences/service";
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
import type {
  LiveWebrtcController,
  LiveWebrtcSnapshot,
} from "@/voice-chat/live/live-webrtc-controller";

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

function supportsLiveWebrtc(serverId: string): boolean {
  const serverInfo = useSessionStore.getState().getSession(serverId)?.serverInfo;
  return serverInfo?.features?.voiceLiveWebrtc === true;
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

async function loadPreferredAgentModes(): Promise<Record<string, string>> {
  const preferences = await createAgentPreferencesService.load().catch(() => null);
  const modes: Record<string, string> = {};
  for (const [provider, prefs] of Object.entries(preferences?.providerPreferences ?? {})) {
    if (prefs.mode) modes[provider] = prefs.mode;
  }
  return modes;
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
  webrtc: LiveWebrtcController | null;
}

// Bumped by every start and hang-up. Work still in flight from an older call (a slow WebRTC
// connect, a mode switch on a weak link) checks it after each await and undoes itself.
let callToken = 0;

class CallCancelledError extends Error {
  constructor() {
    super("The call ended");
  }
}

function assertCurrentCall(token: number): void {
  if (token !== callToken) throw new CallCancelledError();
}

async function teardownCall(deps: CallDeps): Promise<void> {
  await deps.messages.stop().catch(() => undefined);
  await deps.webrtc?.stop({ handoff: false }).catch(() => undefined);
  await deps.runtime.stopVoice().catch(() => undefined);
}

function supportsCallMute(serverId: string): boolean {
  const serverInfo = useSessionStore.getState().getSession(serverId)?.serverInfo;
  return serverInfo?.features?.voiceCallMute === true;
}

/** GPT-Live's own input mute, on top of the silence the phone keeps streaming. */
function syncLiveMute(muted: boolean): void {
  const { callServerId, mode } = useGlobalVoiceStore.getState();
  if (!callServerId || mode !== "live" || !supportsCallMute(callServerId)) return;
  const client = getHostRuntimeStore().getClient(callServerId);
  void client?.setVoiceCallMute({ muted }).catch(() => undefined);
}

/** Mute belongs to the call, not to a mode: a muted user must stay muted across a switch. */
function applyCallMute(deps: CallDeps): void {
  const muted = useGlobalVoiceStore.getState().isMuted;
  syncLiveMute(muted);
  if (deps.messages.isActive()) {
    if (deps.messages.getSnapshot().isMuted !== muted) deps.messages.toggleMute();
    return;
  }
  if (deps.webrtc?.isActive()) {
    if (deps.webrtc.getSnapshot().isMuted !== muted) deps.webrtc.toggleMute();
    return;
  }
  if (deps.runtime.getSnapshot().isVoiceMode && deps.runtime.getSnapshot().isMuted !== muted) {
    deps.runtime.toggleMute();
  }
}

function requireHostClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("disconnected");
  return client;
}

/**
 * Live mode prefers WebRTC straight to GPT-Live, which survives a shaky link to the host;
 * hosts or binaries without it get the audio relayed through the host as before.
 */
async function startLive(
  deps: CallDeps,
  serverId: string,
  agentId: string,
  token: number,
): Promise<void> {
  const store = useGlobalVoiceStore.getState();
  if (deps.webrtc && supportsLiveWebrtc(serverId)) {
    try {
      await deps.webrtc.start({
        signaling: {
          connect: (sdp) =>
            requireHostClient(serverId).connectLiveVoice({ sdp, language: callLanguage(serverId) }),
          end: (sessionId) => requireHostClient(serverId).endLiveVoice({ sessionId }),
        },
      });
      assertCurrentCall(token);
      store.setCall({ liveTransport: "webrtc" });
      logVoiceCallEvent("live_transport", { transport: "webrtc" });
      applyCallMute(deps);
      return;
    } catch (error) {
      assertCurrentCall(token);
      logVoiceCallEvent("live_webrtc_fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await deps.runtime.startVoice(serverId, agentId);
  assertCurrentCall(token);
  store.setCall({ liveTransport: "relay" });
  logVoiceCallEvent("live_transport", { transport: "relay" });
  applyCallMute(deps);
}

async function stopLive(deps: CallDeps, options: { handoff: boolean }): Promise<void> {
  if (deps.webrtc?.isActive()) {
    await deps.webrtc.stop(options);
    return;
  }
  if (options.handoff) {
    deps.runtime.handOffVoice();
    return;
  }
  await deps.runtime.stopVoice();
}

async function startMessages(
  deps: CallDeps,
  serverId: string,
  options: { greet: boolean; intro?: string },
  token: number,
): Promise<void> {
  await deps.messages.start({
    serverId,
    transport: createHostVoiceMessagesTransport({ serverId, language: callLanguage(serverId) }),
    language: callLanguage(serverId),
    greet: options.greet,
    ...(options.intro ? { intro: options.intro } : {}),
  });
  assertCurrentCall(token);
  applyCallMute(deps);
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
  const token = callToken;
  store.setSwitching(true);
  logVoiceCallEvent("mode_switch", { from: store.mode, to: target, reason });
  try {
    if (target === "messages") {
      await stopLive(deps, { handoff: true });
      assertCurrentCall(token);
      await startMessages(
        deps,
        serverId,
        {
          greet: false,
          intro: spoken(reason === "auto" ? "weakSignal" : "switchedToMessages", serverId),
        },
        token,
      );
      store.setCall({ mode: "messages", isAutoMode: reason === "auto" });
      return;
    }
    const agentId = store.orchestratorAgentIds[serverId];
    if (!agentId) throw new Error("The voice assistant is not running on this host.");
    await deps.messages.stop({ handoff: true });
    assertCurrentCall(token);
    try {
      await startLive(deps, serverId, agentId, token);
      store.setCall({ mode: "live", isAutoMode: false });
    } catch (error) {
      if (error instanceof CallCancelledError) throw error;
      logVoiceCallEvent("live_resume_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await startMessages(deps, serverId, { greet: false }, token);
      store.setCall({ mode: "messages", isAutoMode: reason === "auto" });
    }
  } catch (error) {
    if (!(error instanceof CallCancelledError)) throw error;
    await teardownCall(deps);
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
  /** False when the host predates messages mode; the UI offers it but explains the update. */
  canUseWeakSignal: boolean;
  messages: VoiceMessagesSnapshot;
  start: () => void;
  stop: () => void;
  toggleMute: () => void;
  setWeakSignalMode: (enabled: boolean) => void;
}

function resolveWebrtcPhase(liveWebrtc: LiveWebrtcSnapshot): string {
  if (liveWebrtc.state === "connecting") return "starting";
  return liveWebrtc.isAssistantSpeaking ? "playing" : "listening";
}

export function useGlobalVoice(): GlobalVoice {
  const voice = useVoiceOptional();
  const runtime = useVoiceRuntimeOptional();
  const messagesController = useVoiceMessagesController();
  const messages = useVoiceMessagesSnapshot();
  const liveWebrtcController = useLiveWebrtcController();
  const liveWebrtc = useLiveWebrtcSnapshot();
  const toast = useToast();
  const { t, i18n: appI18n } = useTranslation();
  const isStarting = useGlobalVoiceStore((state) => state.isStarting);
  const isSwitching = useGlobalVoiceStore((state) => state.isSwitching);
  const mode = useGlobalVoiceStore((state) => state.mode);
  const isAutoMode = useGlobalVoiceStore((state) => state.isAutoMode);
  const isCallMuted = useGlobalVoiceStore((state) => state.isMuted);
  const callServerId = useGlobalVoiceStore((state) => state.callServerId);
  const canUseWeakSignal = useSessionStore((state) =>
    callServerId
      ? state.getSession(callServerId)?.serverInfo?.features?.voiceMessages === true
      : false,
  );
  const orchestratorAgentIds = useGlobalVoiceStore((state) => state.orchestratorAgentIds);
  const activeServerId = voice?.activeServerId ?? null;
  const activeAgentId = voice?.activeAgentId ?? null;
  const isLiveActive =
    voice !== null &&
    voice.isVoiceMode &&
    activeServerId !== null &&
    activeAgentId !== null &&
    orchestratorAgentIds[activeServerId] === activeAgentId;
  const isActive = isLiveActive || liveWebrtc.active || messages.active;

  const depsRef = useRef<CallDeps | null>(null);
  depsRef.current =
    runtime && messagesController
      ? { runtime, messages: messagesController, webrtc: liveWebrtcController }
      : null;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const stop = useCallback(() => {
    callToken += 1;
    void (async () => {
      const deps = depsRef.current;
      logVoiceCallEvent("call_ended", { mode: useGlobalVoiceStore.getState().mode });
      await deps?.messages.stop().catch(() => undefined);
      await deps?.webrtc?.stop({ handoff: false }).catch(() => undefined);
      await voiceRef.current?.stopVoice().catch((error) => {
        console.error("[GlobalVoice] Failed to stop voice", error);
      });
      await endCallSession().catch((error) => {
        console.warn("[GlobalVoice] Failed to end the call", error);
      });
      stopVoiceCallEventLog();
      const store = useGlobalVoiceStore.getState();
      store.setMinimized(false);
      store.setCall({
        callServerId: null,
        mode: "live",
        isAutoMode: false,
        liveTransport: null,
        isMuted: false,
      });
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
    store.setCall({ isMuted: false });
    callToken += 1;
    const token = callToken;
    void (async () => {
      let callStarted = false;
      try {
        const { agentId, language } = await client.startVoiceOrchestrator({
          language: appI18n.language,
          agentModes: await loadPreferredAgentModes(),
        });
        if (language) voiceLanguages.set(serverId, language);
        useGlobalVoiceStore.getState().setOrchestratorAgentId(serverId, agentId);
        if (isCallKitAvailable()) {
          callStarted = await startCallSession(CALL_DISPLAY_NAME, {
            onEndedBySystem: () => stop(),
            onMuteChanged: (muted) => {
              const current = depsRef.current;
              useGlobalVoiceStore.getState().setCall({ isMuted: muted });
              if (current) applyCallMute(current);
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
        assertCurrentCall(token);
        if (useMessages) {
          await startMessages(deps, serverId, { greet: true }, token);
        } else {
          await startLive(deps, serverId, agentId, token);
        }
      } catch (error) {
        if (error instanceof CallCancelledError) {
          await teardownCall(deps);
          if (callStarted) await endCallSession().catch(() => undefined);
          return;
        }
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
    const store = useGlobalVoiceStore.getState();
    store.setCall({ isMuted: !store.isMuted });
    const deps = depsRef.current;
    if (deps) applyCallMute(deps);
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
    isMuted: isCallMuted,
    phase: liveWebrtc.active ? resolveWebrtcPhase(liveWebrtc) : (voice?.phase ?? "disabled"),
    mode,
    isAutoMode,
    isSwitching,
    canUseWeakSignal,
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
  const liveWebrtcController = useLiveWebrtcController();
  const callServerId = useGlobalVoiceStore((state) => state.callServerId);
  const wasActiveRef = useRef(false);
  // Outlives the effect re-runs a mode switch causes, so relapse backoff keeps growing per call.
  const qualityRef = useRef<{ serverId: string; quality: ConnectionQuality } | null>(null);

  useEffect(() => {
    if (call.isSwitching || call.isStarting) return;
    if (wasActiveRef.current && !call.isActive) {
      void endCallSession().catch(() => undefined);
      stopVoiceCallEventLog();
      useGlobalVoiceStore.getState().setCall({
        callServerId: null,
        mode: "live",
        isAutoMode: false,
        liveTransport: null,
        isMuted: false,
      });
      qualityRef.current = null;
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
    const deps: CallDeps = {
      runtime,
      messages: messagesController,
      webrtc: liveWebrtcController,
    };
    if (!supportsVoiceMessages(callServerId)) return;
    const store = getHostRuntimeStore();
    if (qualityRef.current?.serverId !== callServerId) {
      qualityRef.current = {
        serverId: callServerId,
        quality: new ConnectionQuality(isConnected(callServerId), Date.now()),
      };
    }
    const { quality } = qualityRef.current;
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
      // Over WebRTC the voice doesn't need the host link, so only the voice link's own health counts.
      const liveDegraded =
        state.liveTransport === "webrtc"
          ? (liveWebrtcController?.isDegraded() ?? false)
          : quality.shouldDegrade(now);
      if (state.mode === "live" && liveDegraded) {
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
  }, [call.isActive, callServerId, liveWebrtcController, messagesController, runtime]);
}
