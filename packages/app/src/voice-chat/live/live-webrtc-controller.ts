import type {
  LiveDataChannel,
  LiveMediaStream,
  LivePeerConnection,
  LiveWebrtcRuntime,
} from "@/voice-chat/live/webrtc-runtime-types";

const DATA_CHANNEL_LABEL = "oai-events";
const ICE_GATHER_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 12_000;
const STATS_INTERVAL_MS = 2_000;
const SPEAKING_IDLE_MS = 1_200;
// A link is unusable for live voice once this much audio is lost or the round trip is this slow.
const MAX_LOSS_RATIO = 0.1;
const MAX_RTT_SECONDS = 1;
const UNSTABLE_FOR_MS = 10_000;
const DISCONNECTED_FOR_MS = 3_000;

export type LiveWebrtcState = "idle" | "connecting" | "connected" | "unstable" | "failed";

export interface LiveWebrtcSnapshot {
  active: boolean;
  state: LiveWebrtcState;
  isMuted: boolean;
  isAssistantSpeaking: boolean;
  isUserSpeaking: boolean;
}

export interface LiveWebrtcSignaling {
  connect(sdp: string): Promise<{ sessionId: string; sdp: string }>;
  end(sessionId: string, handoff: boolean): Promise<void>;
}

const INITIAL_SNAPSHOT: LiveWebrtcSnapshot = {
  active: false,
  state: "idle",
  isMuted: false,
  isAssistantSpeaking: false,
  isUserSpeaking: false,
};

interface ActiveLive {
  pc: LivePeerConnection;
  microphone: LiveMediaStream;
  channel: LiveDataChannel;
  signaling: LiveWebrtcSignaling;
  sessionId: string | null;
  cleanups: Array<() => void>;
  statsTimer: ReturnType<typeof setInterval> | null;
  disconnectedSince: number | null;
  unstableSince: number | null;
  lastLost: number;
  lastReceived: number;
}

function waitForIceGathering(pc: LivePeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  let cancelTimer = () => {};
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
    cancelTimer = () => clearTimeout(timer);
  });
  const gathered = new Promise<void>((resolve) => {
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") resolve();
    });
  });
  return Promise.race([timeout, gathered]).finally(cancelTimer);
}

function waitForConnected(pc: LivePeerConnection): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The live voice connection did not open in time")),
      CONNECT_TIMEOUT_MS,
    );
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") {
        clearTimeout(timer);
        resolve();
      } else if (pc.connectionState === "failed") {
        clearTimeout(timer);
        reject(new Error("The live voice connection failed"));
      }
    });
  });
}

/**
 * Live mode over WebRTC: the phone's audio goes straight to GPT-Live with Opus, jitter
 * buffering and loss concealment, and the host only signals the session and controls it
 * through a sideband. A broken link to the host no longer cuts the voice.
 */
export function createLiveWebrtcController(deps: {
  runtime: LiveWebrtcRuntime;
  log(kind: string, detail?: Record<string, unknown>): void;
  /** Frees the app's other audio engine; two voice-processing units in one app break the mic. */
  releaseOtherAudio?: () => Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot: LiveWebrtcSnapshot = INITIAL_SNAPSHOT;
  let live: ActiveLive | null = null;
  let assistantTimer: ReturnType<typeof setTimeout> | null = null;
  let userTimer: ReturnType<typeof setTimeout> | null = null;

  function patch(next: Partial<LiveWebrtcSnapshot>): void {
    const merged = { ...snapshot, ...next };
    if (
      (Object.keys(merged) as Array<keyof LiveWebrtcSnapshot>).every(
        (key) => merged[key] === snapshot[key],
      )
    ) {
      return;
    }
    snapshot = merged;
    for (const listener of listeners) listener();
  }

  function markSpeaking(who: "assistant" | "user"): void {
    if (who === "assistant") {
      patch({ isAssistantSpeaking: true });
      if (assistantTimer) clearTimeout(assistantTimer);
      assistantTimer = setTimeout(() => patch({ isAssistantSpeaking: false }), SPEAKING_IDLE_MS);
      return;
    }
    patch({ isUserSpeaking: true });
    if (userTimer) clearTimeout(userTimer);
    userTimer = setTimeout(() => patch({ isUserSpeaking: false }), SPEAKING_IDLE_MS);
  }

  function handleChannelMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let event: { type?: string };
    try {
      event = JSON.parse(data) as { type?: string };
    } catch {
      return;
    }
    if (event.type === "session.output_transcript.delta") markSpeaking("assistant");
    else if (event.type === "session.input_transcript.delta") markSpeaking("user");
    else if (event.type === "session.closed") {
      deps.log("live_webrtc_session_closed");
      patch({ state: "failed" });
    }
  }

  function trackConnection(active: ActiveLive): void {
    active.pc.addEventListener("connectionstatechange", () => {
      if (live !== active) return;
      const state = active.pc.connectionState;
      deps.log("live_webrtc_state", { state });
      if (state === "connected") {
        active.disconnectedSince = null;
        patch({ state: active.unstableSince ? "unstable" : "connected" });
      } else if (state === "disconnected") {
        active.disconnectedSince ??= now();
        patch({ state: "unstable" });
      } else if (state === "failed" || state === "closed") {
        patch({ state: "failed" });
      }
    });
  }

  async function sampleStats(active: ActiveLive): Promise<void> {
    const report = await active.pc.getStats().catch(() => null);
    if (!report || live !== active) return;
    let lost = 0;
    let received = 0;
    let rtt: number | null = null;
    report.forEach((stat) => {
      if (stat.type === "inbound-rtp" && stat.kind === "audio") {
        lost += Number(stat.packetsLost ?? 0);
        received += Number(stat.packetsReceived ?? 0);
      } else if (stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded") {
        const value = Number(stat.currentRoundTripTime);
        if (Number.isFinite(value)) rtt = value;
      }
    });
    const lostDelta = Math.max(0, lost - active.lastLost);
    const receivedDelta = Math.max(0, received - active.lastReceived);
    active.lastLost = lost;
    active.lastReceived = received;
    const total = lostDelta + receivedDelta;
    const lossRatio = total > 0 ? lostDelta / total : 0;
    const poor = lossRatio > MAX_LOSS_RATIO || (rtt !== null && rtt > MAX_RTT_SECONDS);
    if (poor) {
      if (!active.unstableSince) {
        deps.log("live_webrtc_poor_link", { lossRatio: Number(lossRatio.toFixed(3)), rtt });
      }
      active.unstableSince ??= now();
      if (active.pc.connectionState === "connected") patch({ state: "unstable" });
    } else {
      active.unstableSince = null;
      if (active.pc.connectionState === "connected") patch({ state: "connected" });
    }
  }

  async function start(params: { signaling: LiveWebrtcSignaling }): Promise<void> {
    await stop({ handoff: false });
    patch({ ...INITIAL_SNAPSHOT, active: true, state: "connecting" });
    await deps.releaseOtherAudio?.().catch(() => undefined);
    const microphone = await deps.runtime.getMicrophone();
    const pc = deps.runtime.createPeerConnection();
    const active: ActiveLive = {
      pc,
      microphone,
      channel: pc.createDataChannel(DATA_CHANNEL_LABEL),
      signaling: params.signaling,
      sessionId: null,
      cleanups: [deps.runtime.onCallAudioSession()],
      statsTimer: null,
      disconnectedSince: null,
      unstableSince: null,
      lastLost: 0,
      lastReceived: 0,
    };
    live = active;
    try {
      for (const track of microphone.getAudioTracks()) pc.addTrack(track, microphone);
      active.channel.addEventListener("message", (event) => handleChannelMessage(event.data));
      pc.addEventListener("track", (event) => {
        active.cleanups.push(deps.runtime.attachRemoteAudio(event));
      });
      trackConnection(active);
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      const sdp = pc.localDescription?.sdp ?? offer.sdp;
      if (!sdp) throw new Error("WebRTC produced no offer");
      const answer = await params.signaling.connect(sdp);
      if (live !== active) {
        // Hung up while the host was creating the session: end it there too.
        await params.signaling.end(answer.sessionId, false).catch(() => undefined);
        return;
      }
      active.sessionId = answer.sessionId;
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await waitForConnected(pc);
      if (live !== active) return;
      deps.runtime.preferSpeakerOutput(true);
      active.statsTimer = setInterval(() => void sampleStats(active), STATS_INTERVAL_MS);
      deps.log("live_webrtc_connected", { sessionId: answer.sessionId });
      patch({ state: "connected" });
    } catch (error) {
      deps.log("live_webrtc_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await stop({ handoff: false });
      throw error;
    }
  }

  async function stop(options: { handoff: boolean }): Promise<void> {
    const active = live;
    if (!active) return;
    live = null;
    if (active.statsTimer) clearInterval(active.statsTimer);
    for (const cleanup of active.cleanups) cleanup();
    for (const track of active.microphone.getTracks()) track.stop();
    active.channel.close();
    active.pc.close();
    deps.runtime.preferSpeakerOutput(false);
    if (assistantTimer) clearTimeout(assistantTimer);
    if (userTimer) clearTimeout(userTimer);
    if (active.sessionId) {
      await active.signaling.end(active.sessionId, options.handoff).catch(() => undefined);
    }
    snapshot = INITIAL_SNAPSHOT;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): LiveWebrtcSnapshot {
      return snapshot;
    },
    isActive(): boolean {
      return live !== null;
    },
    start,
    stop,
    toggleMute(): boolean {
      const active = live;
      if (!active) return false;
      const muted = !snapshot.isMuted;
      for (const track of active.microphone.getAudioTracks()) track.enabled = !muted;
      patch({ isMuted: muted });
      return muted;
    },
    /** True when the voice link itself is bad enough that messages mode would serve better. */
    isDegraded(): boolean {
      const active = live;
      if (!active) return false;
      if (active.pc.connectionState === "failed" || snapshot.state === "failed") return true;
      const at = now();
      if (active.disconnectedSince && at - active.disconnectedSince >= DISCONNECTED_FOR_MS) {
        return true;
      }
      return active.unstableSince !== null && at - active.unstableSince >= UNSTABLE_FOR_MS;
    },
  };
}

export type LiveWebrtcController = ReturnType<typeof createLiveWebrtcController>;
