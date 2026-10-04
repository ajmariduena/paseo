import { Buffer } from "buffer";
import { create } from "zustand";
import type { AudioEngine, AudioPlaybackSource } from "@/audio/audio-engine-types";

// Synthesizing further ahead than this spends provider credits on audio a stop would discard.
const MAX_SEGMENTS_AHEAD = 2;
const MAX_STITCHING_REQUEST_IDS = 3;

export type ReadAloudStatus = "preparing" | "playing" | "paused";

export interface ReadAloudTrack {
  serverId: string;
  agentId: string;
  preview: string;
}

interface ReadAloudState {
  activeKey: string | null;
  status: ReadAloudStatus | null;
  track: ReadAloudTrack | null;
}

const IDLE: ReadAloudState = { activeKey: null, status: null, track: null };

export const useReadAloudStore = create<ReadAloudState>(() => IDLE);

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
  serverId?: string;
  agentId?: string;
  client: ReadAloudClient;
  engine: AudioEngine;
}): Promise<void> {
  stopReadAloud();
  const playback: ActivePlayback = { key: input.key, engine: input.engine, cancelled: false };
  active = playback;
  useReadAloudStore.setState({
    activeKey: input.key,
    status: "preparing",
    track:
      input.serverId && input.agentId
        ? { serverId: input.serverId, agentId: input.agentId, preview: toPreview(input.text) }
        : null,
  });

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
      useReadAloudStore.setState(IDLE);
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
  useReadAloudStore.setState(IDLE);
}

export function pauseReadAloud(): void {
  if (!active?.engine.pause || useReadAloudStore.getState().status !== "playing") return;
  active.engine.pause();
  useReadAloudStore.setState({ status: "paused" });
}

export function resumeReadAloud(): void {
  if (!active?.engine.resume || useReadAloudStore.getState().status !== "paused") return;
  active.engine.resume();
  useReadAloudStore.setState({ status: "playing" });
}

const PREVIEW_LENGTH = 140;

function toPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW_LENGTH ? `${plain.slice(0, PREVIEW_LENGTH).trimEnd()}…` : plain;
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
