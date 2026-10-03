import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { randomUUID } from "expo-crypto";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { i18n } from "@/i18n/i18next";
import { logVoiceCallEvent } from "@/voice-chat/call-event-log";
import { createDeviceSpeech } from "@/voice-chat/messages/device-speech";
import {
  createVoiceMessagesController,
  type VoiceMessagesController,
  type VoiceMessagesSnapshot,
} from "@/voice-chat/messages/messages-controller";
import { useSessionStore } from "@/stores/session-store";
import { createAudioEngine } from "@/voice/audio-engine";
import type { AudioEngine } from "@/voice/audio-engine-types";
import {
  createVoiceRuntime,
  type VoiceRuntime,
  type VoiceRuntimeSnapshot,
  type VoiceRuntimeTelemetrySnapshot,
} from "@/voice/voice-runtime";

interface VoiceContextValue extends VoiceRuntimeSnapshot {
  startVoice: (serverId: string, agentId: string) => Promise<void>;
  stopVoice: () => Promise<void>;
  isVoiceModeForAgent: (serverId: string, agentId: string) => boolean;
  toggleMute: () => void;
}

const EMPTY_SNAPSHOT: VoiceRuntimeSnapshot = {
  phase: "disabled",
  isVoiceMode: false,
  isVoiceSwitching: false,
  isMuted: false,
  activeServerId: null,
  activeAgentId: null,
};

const EMPTY_TELEMETRY: VoiceRuntimeTelemetrySnapshot = {
  volume: 0,
  isSpeaking: false,
  segmentDuration: 0,
};

const VoiceRuntimeContext = createContext<VoiceRuntime | null>(null);
const VoiceMessagesContext = createContext<VoiceMessagesController | null>(null);
const VoiceAudioEngineContext = createContext<AudioEngine | null>(null);

const noopSubscribe = () => () => {};
const getEmptySnapshot = () => EMPTY_SNAPSHOT;
const getEmptyTelemetry = () => EMPTY_TELEMETRY;

export function useVoice() {
  const value = useVoiceOptional();
  if (!value) {
    throw new Error("useVoice must be used within VoiceProvider");
  }
  return value;
}

export function useVoiceOptional(): VoiceContextValue | null {
  const runtime = useContext(VoiceRuntimeContext);
  const snapshot = useSyncExternalStore(
    runtime ? runtime.subscribe : noopSubscribe,
    runtime ? runtime.getSnapshot : getEmptySnapshot,
    runtime ? runtime.getSnapshot : getEmptySnapshot,
  );

  // Methods on the runtime object literal close over factory-local state; they
  // don't use `this`, so no binding is needed. Memoising on [snapshot, runtime]
  // keeps the returned object reference stable across re-renders that don't
  // change either, preventing downstream memo/useMemo misses.
  return useMemo(() => {
    if (!runtime) {
      return null;
    }
    return {
      ...snapshot,
      startVoice: runtime.startVoice,
      stopVoice: runtime.stopVoice,
      isVoiceModeForAgent: runtime.isVoiceModeForAgent,
      toggleMute: runtime.toggleMute,
    };
  }, [snapshot, runtime]);
}

export function useVoiceTelemetry() {
  const telemetry = useVoiceTelemetryOptional();
  if (!telemetry) {
    throw new Error("useVoiceTelemetry must be used within VoiceProvider");
  }
  return telemetry;
}

export function useVoiceTelemetryOptional(): VoiceRuntimeTelemetrySnapshot | null {
  const runtime = useContext(VoiceRuntimeContext);
  const snapshot = useSyncExternalStore(
    runtime ? runtime.subscribeTelemetry.bind(runtime) : noopSubscribe,
    runtime ? runtime.getTelemetrySnapshot.bind(runtime) : getEmptyTelemetry,
    runtime ? runtime.getTelemetrySnapshot.bind(runtime) : getEmptyTelemetry,
  );

  return runtime ? snapshot : null;
}

export function useVoiceRuntimeOptional(): VoiceRuntime | null {
  return useContext(VoiceRuntimeContext);
}

export function useVoiceAudioEngineOptional(): AudioEngine | null {
  return useContext(VoiceAudioEngineContext);
}

export function useVoiceMessagesController(): VoiceMessagesController | null {
  return useContext(VoiceMessagesContext);
}

const INACTIVE_MESSAGES: VoiceMessagesSnapshot = {
  active: false,
  serverId: null,
  callId: null,
  phase: "idle",
  connected: false,
  pendingSends: 0,
  isMuted: false,
  lastHeard: null,
  lastSpoken: null,
};
const getInactiveMessages = () => INACTIVE_MESSAGES;

export function useVoiceMessagesSnapshot(): VoiceMessagesSnapshot {
  const controller = useContext(VoiceMessagesContext);
  return useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getSnapshot : getInactiveMessages,
    controller ? controller.getSnapshot : getInactiveMessages,
  );
}

interface VoiceProviderProps {
  children: ReactNode;
}

export function VoiceProvider({ children }: VoiceProviderProps) {
  const engineRef = useRef<AudioEngine | null>(null);
  const runtimeRef = useRef<VoiceRuntime | null>(null);
  const messagesRef = useRef<VoiceMessagesController | null>(null);

  if (!engineRef.current) {
    let runtime: VoiceRuntime | null = null;
    let messages: VoiceMessagesController | null = null;
    const engine = createAudioEngine({
      onCaptureData: (pcm) => {
        if (messages?.isActive()) {
          messages.handleCapturePcm(pcm);
          return;
        }
        runtime?.handleCapturePcm(pcm);
      },
      onVolumeLevel: (level) => {
        if (messages?.isActive()) return;
        runtime?.handleCaptureVolume(level);
      },
      onInterruption: () => {
        logVoiceCallEvent("audio_interruption");
        if (messages?.isActive()) {
          void messages.stop().catch(() => undefined);
          return;
        }
        void runtime?.stopVoice().catch((error) => {
          console.error("[VoiceEngine] Failed to stop after audio interruption:", error);
        });
      },
      onError: (error) => {
        console.error("[VoiceEngine] Capture error:", error);
      },
    });

    runtime = createVoiceRuntime({
      engine,
      getServerInfo: (serverId) =>
        useSessionStore.getState().getSession(serverId)?.serverInfo ?? null,
      activateKeepAwake: async (tag) => {
        await activateKeepAwakeAsync(tag);
      },
      deactivateKeepAwake: async (tag) => {
        await deactivateKeepAwake(tag);
      },
    });

    messages = createVoiceMessagesController({
      engine,
      speech: createDeviceSpeech(),
      phrase: (key, language) => i18n.t(`globalVoice.spoken.${key}`, { lng: language }),
      log: logVoiceCallEvent,
      activateKeepAwake: async (tag) => {
        await activateKeepAwakeAsync(tag);
      },
      deactivateKeepAwake: async (tag) => {
        await deactivateKeepAwake(tag);
      },
      createId: () => randomUUID(),
    });

    engineRef.current = engine;
    runtimeRef.current = runtime;
    messagesRef.current = messages;
  }

  const engine = engineRef.current;
  const runtime = runtimeRef.current!;
  const messages = messagesRef.current!;

  useEffect(() => {
    return () => {
      void messages.stop().catch(() => undefined);
      void runtime.destroy().catch((error) => {
        console.error("[VoiceProvider] Failed to destroy voice runtime", error);
      });
    };
  }, [messages, runtime]);

  return (
    <VoiceAudioEngineContext.Provider value={engine}>
      <VoiceRuntimeContext.Provider value={runtime}>
        <VoiceMessagesContext.Provider value={messages}>{children}</VoiceMessagesContext.Provider>
      </VoiceRuntimeContext.Provider>
    </VoiceAudioEngineContext.Provider>
  );
}
