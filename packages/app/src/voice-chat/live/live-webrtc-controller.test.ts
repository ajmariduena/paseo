import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveWebrtcController } from "./live-webrtc-controller";
import type { LivePeerConnection, LiveWebrtcRuntime } from "./webrtc-runtime-types";

function createFakeRuntime() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const channelListeners: Array<(event: { data: unknown }) => void> = [];
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      track.stopped = true;
    },
  };
  const state = {
    connectionState: "new",
    remote: null as string | null,
    closed: false,
    speakerCalls: [] as boolean[],
  };
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener({});
  };
  const pc: LivePeerConnection = {
    get connectionState() {
      return state.connectionState;
    },
    iceGatheringState: "complete",
    localDescription: { sdp: "v=0 offer", type: "offer" },
    addTrack: () => undefined,
    createDataChannel: () => ({
      readyState: "open",
      addEventListener: (_type, listener) => channelListeners.push(listener),
      close: () => undefined,
    }),
    createOffer: async () => ({ sdp: "v=0 offer", type: "offer" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async (description) => {
      state.remote = description.sdp;
      queueMicrotask(() => {
        state.connectionState = "connected";
        emit("connectionstatechange");
      });
    },
    getStats: async () => ({ forEach: () => undefined }),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close: () => {
      state.closed = true;
    },
  };
  const runtime: LiveWebrtcRuntime = {
    createPeerConnection: () => pc,
    getMicrophone: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    attachRemoteAudio: () => () => undefined,
    onCallAudioSession: () => () => undefined,
    preferSpeakerOutput: (enabled) => state.speakerCalls.push(enabled),
  };
  return {
    runtime,
    state,
    track,
    setConnectionState(next: string) {
      state.connectionState = next;
      emit("connectionstatechange");
    },
    sendEvent(event: Record<string, unknown>) {
      for (const listener of channelListeners) listener({ data: JSON.stringify(event) });
    },
  };
}

describe("live WebRTC controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startConnected() {
    const fake = createFakeRuntime();
    const ended: Array<[string, boolean]> = [];
    const controller = createLiveWebrtcController({ runtime: fake.runtime, log: () => undefined });
    const connect = vi.fn(async (sdp: string) => ({
      sessionId: "live_1",
      sdp: `answer for ${sdp}`,
    }));
    await controller.start({
      signaling: {
        connect,
        end: async (sessionId, handoff) => {
          ended.push([sessionId, handoff]);
        },
      },
    });
    return { fake, controller, connect, ended };
  }

  it("trades the offer through the host and connects with the loudspeaker preferred", async () => {
    const { fake, controller, connect } = await startConnected();

    expect(connect).toHaveBeenCalledWith("v=0 offer");
    expect(fake.state.remote).toBe("answer for v=0 offer");
    expect(controller.getSnapshot()).toMatchObject({ active: true, state: "connected" });
    expect(fake.state.speakerCalls).toEqual([true]);
  });

  it("tracks who is speaking from data channel transcripts", async () => {
    const { fake, controller } = await startConnected();
    fake.sendEvent({ type: "session.output_transcript.delta", delta: "Hola" });
    expect(controller.getSnapshot().isAssistantSpeaking).toBe(true);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(controller.getSnapshot().isAssistantSpeaking).toBe(false);
  });

  it("reports a degraded link after a sustained disconnect", async () => {
    const { fake, controller } = await startConnected();
    fake.setConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.isDegraded()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(controller.isDegraded()).toBe(true);
  });

  it("mutes by disabling the microphone track", async () => {
    const { fake, controller } = await startConnected();
    expect(controller.toggleMute()).toBe(true);
    expect(fake.track.enabled).toBe(false);
  });

  it("tears down and ends the host session on stop", async () => {
    const { fake, controller, ended } = await startConnected();
    await controller.stop({ handoff: true });

    expect(ended).toEqual([["live_1", true]]);
    expect(fake.state.closed).toBe(true);
    expect(fake.track.stopped).toBe(true);
    expect(controller.getSnapshot().active).toBe(false);
  });

  it("cleans up and rethrows when the host can't create the session", async () => {
    const fake = createFakeRuntime();
    const controller = createLiveWebrtcController({ runtime: fake.runtime, log: () => undefined });
    await expect(
      controller.start({
        signaling: {
          connect: async () => {
            throw new Error("GPT-Live is not configured on this host.");
          },
          end: async () => undefined,
        },
      }),
    ).rejects.toThrow("GPT-Live is not configured");

    expect(fake.state.closed).toBe(true);
    expect(controller.isActive()).toBe(false);
  });
});
