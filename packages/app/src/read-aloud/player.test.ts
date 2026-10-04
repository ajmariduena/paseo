import { afterEach, describe, expect, it } from "vitest";
import type { AudioEngine, AudioPlaybackSource } from "@/audio/audio-engine-types";
import {
  pauseReadAloud,
  resumeReadAloud,
  startReadAloud,
  stopReadAloud,
  useReadAloudStore,
  type ReadAloudClient,
} from "./player";

interface PendingPlay {
  type: string;
  bytes: number[];
  finish(): void;
}

function createEngine(): {
  engine: AudioEngine;
  plays: PendingPlay[];
  stops: number;
  calls: string[];
} {
  const plays: PendingPlay[] = [];
  const queue: Array<{ reject(error: Error): void }> = [];
  const state = { stops: 0 };
  const calls: string[] = [];
  const engine: AudioEngine = {
    initialize: async () => {},
    destroy: async () => {},
    startCapture: async () => {},
    stopCapture: async () => {},
    toggleMute: () => false,
    isMuted: () => false,
    play: async (audio: AudioPlaybackSource) => {
      const bytes = Array.from(new Uint8Array(await audio.arrayBuffer()));
      return new Promise<number>((resolve, reject) => {
        queue.push({ reject });
        plays.push({ type: audio.type, bytes, finish: () => resolve(1) });
      });
    },
    stop: () => {
      state.stops += 1;
      for (const entry of queue.splice(0)) entry.reject(new Error("Playback stopped"));
    },
    clearQueue: () => {},
    isPlaying: () => false,
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
  };
  return {
    engine,
    plays,
    calls,
    get stops() {
      return state.stops;
    },
  };
}

function createClient(segments: string[]): {
  client: ReadAloudClient;
  synthesized: Array<{ text: string; previousRequestIds?: string[] }>;
} {
  const synthesized: Array<{ text: string; previousRequestIds?: string[] }> = [];
  return {
    synthesized,
    client: {
      prepareReadAloud: async () => segments,
      synthesizeReadAloud: async (params) => {
        synthesized.push(params);
        return {
          audio: Buffer.from([synthesized.length]).toString("base64"),
          format: "pcm;rate=24000",
          providerRequestId: `req-${synthesized.length}`,
        };
      },
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => {
  stopReadAloud();
});

describe("startReadAloud", () => {
  it("plays every segment in order and stitches each request to the previous ones", async () => {
    const { engine, plays } = createEngine();
    const { client, synthesized } = createClient(["uno", "dos", "tres"]);

    const done = startReadAloud({ key: "turn-1", text: "texto", agentId: "a1", client, engine });
    await flush();
    expect(useReadAloudStore.getState()).toEqual({
      activeKey: "turn-1",
      status: "playing",
      track: null,
    });
    plays[0].finish();
    await flush();
    plays[1].finish();
    await flush();
    plays[2].finish();
    await done;

    expect(synthesized).toEqual([
      { text: "uno", previousRequestIds: [] },
      { text: "dos", previousRequestIds: ["req-1"] },
      { text: "tres", previousRequestIds: ["req-1", "req-2"] },
    ]);
    expect(plays.map((play) => ({ type: play.type, bytes: play.bytes }))).toEqual([
      { type: "audio/pcm;rate=24000", bytes: [1] },
      { type: "audio/pcm;rate=24000", bytes: [2] },
      { type: "audio/pcm;rate=24000", bytes: [3] },
    ]);
    expect(useReadAloudStore.getState()).toEqual({ activeKey: null, status: null, track: null });
  });

  it("stops playback and synthesizes nothing more once stopped", async () => {
    const recorder = createEngine();
    const { client, synthesized } = createClient(["uno", "dos", "tres", "cuatro"]);

    const done = startReadAloud({
      key: "turn-1",
      text: "texto",
      client,
      engine: recorder.engine,
    });
    await flush();
    stopReadAloud();
    await done;

    expect(synthesized.map((entry) => entry.text)).toEqual(["uno", "dos"]);
    expect(recorder.stops).toBe(1);
    expect(useReadAloudStore.getState()).toEqual({ activeKey: null, status: null, track: null });
  });

  it("surfaces a synthesis failure to the caller", async () => {
    const { engine } = createEngine();
    const client: ReadAloudClient = {
      prepareReadAloud: async () => ["uno"],
      synthesizeReadAloud: async () => {
        throw new Error("ElevenLabs account has no credits left");
      },
    };

    await expect(startReadAloud({ key: "turn-1", text: "texto", client, engine })).rejects.toThrow(
      "ElevenLabs account has no credits left",
    );
    expect(useReadAloudStore.getState()).toEqual({ activeKey: null, status: null, track: null });
  });

  it("names the agent being read and pauses and resumes it in place", async () => {
    const { engine, plays, calls } = createEngine();
    const { client } = createClient(["uno"]);

    const done = startReadAloud({
      key: "s1:a1:turn-1",
      text: "## Listo\n\nEl **login** ya funciona.",
      serverId: "s1",
      agentId: "a1",
      client,
      engine,
    });
    await flush();
    expect(useReadAloudStore.getState().track).toEqual({
      serverId: "s1",
      agentId: "a1",
      preview: "Listo El login ya funciona.",
    });

    pauseReadAloud();
    expect(useReadAloudStore.getState().status).toBe("paused");
    resumeReadAloud();
    expect(useReadAloudStore.getState().status).toBe("playing");
    expect(calls).toEqual(["pause", "resume"]);

    plays[0].finish();
    await done;
    expect(useReadAloudStore.getState().track).toBeNull();
  });

  it("does not pause before any audio is playing", async () => {
    const { engine, calls } = createEngine();
    const client: ReadAloudClient = {
      prepareReadAloud: () => new Promise(() => {}),
      synthesizeReadAloud: async () => ({ audio: "", format: "pcm", providerRequestId: null }),
    };

    void startReadAloud({ key: "turn-1", text: "texto", client, engine });
    pauseReadAloud();

    expect(useReadAloudStore.getState().status).toBe("preparing");
    expect(calls).toEqual([]);
  });
});
