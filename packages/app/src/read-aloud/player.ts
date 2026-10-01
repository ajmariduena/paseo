import { Buffer } from "buffer";
import { create } from "zustand";
import type { AudioEngine, AudioPlaybackSource } from "@/voice/audio-engine-types";

// Synthesizing further ahead than this spends provider credits on audio a stop would discard.
const MAX_SEGMENTS_AHEAD = 2;
const MAX_STITCHING_REQUEST_IDS = 3;

export type ReadAloudStatus = "preparing" | "playing";

interface ReadAloudState {
  activeKey: string | null;
  status: ReadAloudStatus | null;
}

export const useReadAloudStore = create<ReadAloudState>(() => ({ activeKey: null, status: null }));

export interface ReadAloudClient {
  prepareReadAloud(params: { text: string; agentId?: string }): Promise<string[]>;
  synthesizeReadAloud(params: {
    text: string;
    previousRequestIds?: string[];
  }): Promise<{ audio: string; format: string; providerRequestId: string | null }>;
}

interface ActivePlayback {
  key: string;
  engine: AudioEngine;
  cancelled: boolean;
}

let active: ActivePlayback | null = null;

export async function startReadAloud(input: {
  key: string;
  text: string;
  agentId?: string;
  client: ReadAloudClient;
  engine: AudioEngine;
}): Promise<void> {
  stopReadAloud();
  const playback: ActivePlayback = { key: input.key, engine: input.engine, cancelled: false };
  active = playback;
  useReadAloudStore.setState({ activeKey: input.key, status: "preparing" });

  try {
    const segments = await input.client.prepareReadAloud({
      text: input.text,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
    const requestIds: string[] = [];
    const settled: Promise<unknown>[] = [];
    for (const [index, segment] of segments.entries()) {
      if (index >= MAX_SEGMENTS_AHEAD) {
        await settled[index - MAX_SEGMENTS_AHEAD];
      }
      if (playback.cancelled) return;
      const result = await input.client.synthesizeReadAloud({
        text: segment,
        previousRequestIds: requestIds.slice(-MAX_STITCHING_REQUEST_IDS),
      });
      if (playback.cancelled) return;
      if (result.providerRequestId) requestIds.push(result.providerRequestId);
      if (index === 0) useReadAloudStore.setState({ status: "playing" });
      settled.push(
        input.engine.play(toPlaybackSource(result.audio, result.format)).then(
          () => null,
          (error: unknown) => error,
        ),
      );
    }
    for (const outcome of settled) {
      const error = await outcome;
      if (error && !playback.cancelled) throw error;
    }
  } catch (error) {
    if (!playback.cancelled) throw error;
  } finally {
    if (active === playback) {
      active = null;
      useReadAloudStore.setState({ activeKey: null, status: null });
    }
  }
}

export function stopReadAloud(): void {
  const playback = active;
  if (!playback) return;
  playback.cancelled = true;
  active = null;
  playback.engine.clearQueue();
  playback.engine.stop();
  useReadAloudStore.setState({ activeKey: null, status: null });
}

function toPlaybackSource(base64: string, format: string): AudioPlaybackSource {
  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  return {
    size: bytes.byteLength,
    type: `audio/${format}`,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}
