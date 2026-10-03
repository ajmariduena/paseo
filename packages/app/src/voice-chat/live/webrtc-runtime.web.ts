import type {
  LiveMediaStream,
  LivePeerConnection,
  LiveWebrtcRuntime,
} from "@/voice-chat/live/webrtc-runtime-types";

export function getLiveWebrtcRuntime(): LiveWebrtcRuntime | null {
  if (typeof window === "undefined" || typeof window.RTCPeerConnection === "undefined") {
    return null;
  }
  return {
    createPeerConnection: () => new window.RTCPeerConnection() as unknown as LivePeerConnection,
    getMicrophone: async () =>
      (await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })) as unknown as LiveMediaStream,
    attachRemoteAudio(event) {
      const stream = (event as RTCTrackEvent).streams[0];
      if (!stream) return () => undefined;
      const element = new Audio();
      element.autoplay = true;
      element.srcObject = stream;
      void element.play().catch(() => undefined);
      return () => {
        element.pause();
        element.srcObject = null;
      };
    },
    onCallAudioSession: () => () => undefined,
    preferSpeakerOutput: () => undefined,
  };
}
