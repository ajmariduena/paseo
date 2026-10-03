import { NativeModules } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type {
  LiveMediaStream,
  LivePeerConnection,
  LiveWebrtcRuntime,
} from "@/voice-chat/live/webrtc-runtime-types";

interface ReactNativeWebrtc {
  RTCPeerConnection: new (config: Record<string, unknown>) => LivePeerConnection;
  mediaDevices: { getUserMedia(constraints: Record<string, unknown>): Promise<LiveMediaStream> };
  RTCAudioSession: { audioSessionDidActivate(): void; audioSessionDidDeactivate(): void };
}

interface CallAudioEvents {
  addListener(eventName: string, handler: () => void): { remove(): void };
}

interface SpeakerControl {
  setPreferSpeaker(enabled: boolean): void;
}

let cached: LiveWebrtcRuntime | null | undefined;

/** Null on binaries built before react-native-webrtc was added; live mode then uses the relay. */
export function getLiveWebrtcRuntime(): LiveWebrtcRuntime | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (!NativeModules.WebRTCModule) return cached;
  let webrtc: ReactNativeWebrtc;
  try {
    webrtc = require("react-native-webrtc") as ReactNativeWebrtc;
  } catch {
    return cached;
  }
  const callEvents = requireOptionalNativeModule<CallAudioEvents>("PaseoCall");
  const speaker = requireOptionalNativeModule<SpeakerControl>("PaseoSpeech");
  cached = {
    createPeerConnection: () => new webrtc.RTCPeerConnection({}),
    getMicrophone: () => webrtc.mediaDevices.getUserMedia({ audio: true, video: false }),
    attachRemoteAudio: () => () => undefined,
    onCallAudioSession() {
      if (!callEvents) return () => undefined;
      const activated = callEvents.addListener("onAudioSessionActivated", () =>
        webrtc.RTCAudioSession.audioSessionDidActivate(),
      );
      const deactivated = callEvents.addListener("onAudioSessionDeactivated", () =>
        webrtc.RTCAudioSession.audioSessionDidDeactivate(),
      );
      return () => {
        activated.remove();
        deactivated.remove();
      };
    },
    preferSpeakerOutput(enabled) {
      speaker?.setPreferSpeaker(enabled);
    },
  };
  return cached;
}
