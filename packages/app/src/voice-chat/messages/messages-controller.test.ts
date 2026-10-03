import type { VoiceMessagesItem } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioEngine, AudioPlaybackSource } from "@/voice/audio-engine-types";
import type { DeviceSpeech } from "./device-speech-types";
import { createVoiceMessagesController, type VoiceMessagesTransport } from "./messages-controller";

const SAMPLES_PER_CHUNK = 1600;

function tone(amplitude: number): Uint8Array {
  const out = new Uint8Array(SAMPLES_PER_CHUNK * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < SAMPLES_PER_CHUNK; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin(index / 3) * amplitude * 32767), true);
  }
  return out;
}

function createEngine() {
  const played: string[] = [];
  const engine: AudioEngine = {
    initialize: async () => undefined,
    destroy: async () => undefined,
    startCapture: async () => undefined,
    stopCapture: async () => undefined,
    toggleMute: () => false,
    isMuted: () => false,
    play: async (audio: AudioPlaybackSource) => {
      played.push(audio.type);
      return 0;
    },
    stop: () => undefined,
    clearQueue: () => undefined,
    isPlaying: () => false,
  };
  return { engine, played };
}

function createSpeech(overrides: Partial<DeviceSpeech> = {}) {
  const synthesized: string[] = [];
  const speech: DeviceSpeech = {
    transcribe: async () => "¿cómo va auth?",
    compress: async () => ({ data: new Uint8Array(30 * 1024), mimeType: "audio/mp4" }),
    decode: async () => ({ pcm: new Uint8Array(100), sampleRate: 22050 }),
    synthesize: async (text) => {
      synthesized.push(text);
      return { pcm: new Uint8Array(100), sampleRate: 11025 };
    },
    ...overrides,
  };
  return { speech, synthesized };
}

function createTransport() {
  let connected = true;
  let updateListener: ((callId: string, item: VoiceMessagesItem) => void) | null = null;
  let connectionListener: ((connected: boolean) => void) | null = null;
  const sent: Array<Record<string, unknown>> = [];
  const starts: Array<{ callId: string; greet: boolean }> = [];
  let hostLastSeq = 0;
  let syncActive = true;
  let failNextWith: string | null = null;
  const transport: VoiceMessagesTransport = {
    start: async (params) => {
      starts.push(params);
      syncActive = true;
      return { lastSeq: hostLastSeq, language: "es" };
    },
    sendUtterance: async (params) => {
      if (!connected) throw new Error("disconnected");
      if (failNextWith) {
        const error = failNextWith;
        failNextWith = null;
        return { receivedChunks: 0, audioComplete: false, error };
      }
      sent.push(params);
      const complete =
        params.chunkCount !== undefined && params.chunkIndex === params.chunkCount - 1;
      return {
        receivedChunks: (params.chunkIndex ?? -1) + 1,
        audioComplete: complete,
        error: null,
      };
    },
    sync: async () => ({ active: syncActive, items: [] }),
    getAudio: async ({ offset }) => ({
      audio: Buffer.from(new Uint8Array(offset === 0 ? 10 : 0)).toString("base64"),
      total: 10,
      mimeType: "audio/mpeg",
    }),
    end: async () => undefined,
    isConnected: () => connected,
    subscribeConnection: (listener) => {
      connectionListener = listener;
      return () => undefined;
    },
    subscribeUpdates: (listener) => {
      updateListener = listener;
      return () => undefined;
    },
  };
  return {
    transport,
    sent,
    starts,
    loseHostCall() {
      syncActive = false;
      hostLastSeq = 0;
    },
    failNext(error: string) {
      failNextWith = error;
    },
    setConnected(next: boolean) {
      connected = next;
      connectionListener?.(next);
    },
    push(item: Partial<VoiceMessagesItem> & { seq: number }) {
      updateListener?.("call-1", {
        id: `item-${item.seq}`,
        kind: "reply",
        text: "",
        code: null,
        utteranceId: null,
        createdAt: new Date().toISOString(),
        audio: null,
        ...item,
      });
    },
  };
}

async function setup(
  speechOverrides: Partial<DeviceSpeech> = {},
  options: { offline?: boolean; intro?: string } = {},
) {
  const { engine, played } = createEngine();
  const { speech, synthesized } = createSpeech(speechOverrides);
  const network = createTransport();
  if (options.offline) network.setConnected(false);
  const ids = ["call-1", "utt-1", "utt-2"];
  const controller = createVoiceMessagesController({
    engine,
    speech,
    phrase: (key) => (key === "notHeard" ? "No te escuché" : "Falló"),
    log: () => undefined,
    activateKeepAwake: async () => undefined,
    deactivateKeepAwake: async () => undefined,
    createId: () => ids.shift() ?? "extra",
  });
  await controller.start({
    serverId: "srv",
    transport: network.transport,
    language: "es",
    greet: true,
    ...(options.intro ? { intro: options.intro } : {}),
  });
  return { controller, network, played, synthesized };
}

function speakUtterance(controller: ReturnType<typeof createVoiceMessagesController>): void {
  for (let index = 0; index < 10; index += 1) controller.handleCapturePcm(tone(0.002));
  for (let index = 0; index < 10; index += 1) controller.handleCapturePcm(tone(0.3));
  for (let index = 0; index < 14; index += 1) controller.handleCapturePcm(tone(0.002));
}

describe("voice messages controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends device text first, then the compressed audio in chunks", async () => {
    const { controller, network } = await setup();
    speakUtterance(controller);
    expect(controller.getSnapshot()).toMatchObject({ pendingSends: 1 });
    await vi.advanceTimersByTimeAsync(100);

    expect(network.sent[0]).toEqual({
      callId: "call-1",
      utteranceId: "utt-1",
      text: "¿cómo va auth?",
    });
    expect(network.sent.slice(1).map((part) => [part.chunkIndex, part.chunkCount])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(controller.getSnapshot()).toMatchObject({ phase: "waiting", pendingSends: 0 });
  });

  it("holds the utterance while offline and sends it after reconnecting", async () => {
    const { controller, network } = await setup();
    network.setConnected(false);
    speakUtterance(controller);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(network.sent).toEqual([]);
    expect(controller.getSnapshot().pendingSends).toBe(1);

    network.setConnected(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(network.sent.map((part) => part.utteranceId)).toEqual([
      "utt-1",
      "utt-1",
      "utt-1",
      "utt-1",
    ]);
  });

  it("resumes the call under the same id when the host lost it", async () => {
    const { controller, network } = await setup();
    network.failNext("call_not_found");
    speakUtterance(controller);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(network.starts).toEqual([
      { callId: "call-1", greet: true },
      { callId: "call-1", greet: false },
    ]);
    expect(network.sent[0]).toMatchObject({ text: "¿cómo va auth?" });
  });

  it("plays the host's voice when its audio arrives in time", async () => {
    const { network, played, synthesized } = await setup();
    network.push({ seq: 1, text: "auth terminó" });
    await vi.advanceTimersByTimeAsync(500);
    network.push({ seq: 1, text: "auth terminó", audio: { mimeType: "audio/mpeg", size: 10 } });
    await vi.advanceTimersByTimeAsync(100);

    expect(played).toEqual(["audio/pcm;rate=22050;bits=16"]);
    expect(synthesized).toEqual([]);
  });

  it("falls back to the phone's own voice when the host audio is late", async () => {
    const { network, played, synthesized, controller } = await setup();
    network.push({ seq: 1, text: "auth terminó" });
    await vi.advanceTimersByTimeAsync(4_100);

    expect(synthesized).toEqual(["auth terminó"]);
    expect(played).toEqual(["audio/pcm;rate=11025;bits=16"]);
    expect(controller.getSnapshot().lastSpoken).toBe("auth terminó");
  });

  it("speaks a local phrase for a status it could not hear and plays each item once", async () => {
    const { network, synthesized } = await setup();
    network.push({ seq: 2, kind: "status", code: "not_heard" });
    network.push({ seq: 2, kind: "status", code: "not_heard" });
    await vi.advanceTimersByTimeAsync(100);

    expect(synthesized).toEqual(["No te escuché"]);
  });

  it("starts offline, says why with the phone's voice, and reaches the host later", async () => {
    const { controller, network, synthesized } = await setup(
      {},
      { offline: true, intro: "Señal débil: paso a modo mensajes" },
    );
    speakUtterance(controller);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(synthesized).toEqual(["Señal débil: paso a modo mensajes"]);
    expect(network.starts).toEqual([]);

    network.setConnected(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(network.starts).toEqual([{ callId: "call-1", greet: true }]);
    expect(network.sent[0]).toMatchObject({ utteranceId: "utt-1", text: "¿cómo va auth?" });
  });

  it("starts numbering over when the host lost the call, so new replies still play", async () => {
    const { network, synthesized } = await setup();
    network.push({ seq: 1, text: "uno" });
    network.push({ seq: 2, text: "dos" });
    await vi.advanceTimersByTimeAsync(8_500);
    expect(synthesized).toEqual(["uno", "dos"]);

    network.loseHostCall();
    await vi.advanceTimersByTimeAsync(4_100);
    network.push({ seq: 1, text: "después del reinicio" });
    await vi.advanceTimersByTimeAsync(4_200);

    expect(synthesized).toEqual(["uno", "dos", "después del reinicio"]);
  });
});
