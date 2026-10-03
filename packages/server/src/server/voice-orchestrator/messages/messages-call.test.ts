import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceOrchestrator, VoiceOrchestratorCall } from "../orchestrator.js";
import { VoiceMessagesCall, type VoiceMessagesItem } from "./messages-call.js";

interface FakeOrchestrator {
  language: string;
  call: VoiceOrchestratorCall | null;
  requests: string[];
  narrations: string[][];
  attachCall(call: VoiceOrchestratorCall): () => void;
  runDelegation(params: { request: string; history: string[] }): Promise<string>;
  narrate(params: { kind: string; lines: string[] }): Promise<string>;
  saveCallHistory(): void;
}

function createOrchestrator(): FakeOrchestrator {
  const fake: FakeOrchestrator = {
    language: "es",
    call: null,
    requests: [],
    narrations: [],
    attachCall(call) {
      fake.call = call;
      return () => {
        fake.call = null;
      };
    },
    async runDelegation({ request }) {
      fake.requests.push(request);
      return `Respuesta a: ${request}`;
    },
    saveCallHistory() {},
    async narrate({ lines }) {
      fake.narrations.push(lines);
      return "auth terminó.";
    },
  };
  return fake;
}

function createCall(params: {
  orchestrator: FakeOrchestrator;
  transcribed?: string;
  pushes?: unknown[];
}) {
  const updates: VoiceMessagesItem[] = [];
  const call = new VoiceMessagesCall({
    callId: "call-1",
    orchestrator: params.orchestrator as unknown as VoiceOrchestrator,
    speech: {
      resolveStt: () => ({
        id: "elevenlabs",
        createSession: () => {
          throw new Error("not used");
        },
        transcribeClip: async () => ({ text: params.transcribed ?? "" }),
      }),
      resolveTts: () => ({
        synthesizeSpeech: async () => {
          throw new Error("not used");
        },
        synthesizeCompressed: async (text: string) => ({
          audio: Buffer.from(`mp3:${text}`),
          mimeType: "audio/mpeg",
        }),
      }),
    },
    history: [],
    greet: false,
    sendPush: (payload) => params.pushes?.push(payload),
    logger: pino({ level: "silent" }),
  });
  call.setListener((item) => updates.push(item));
  call.start();
  return { call, updates };
}

describe("VoiceMessagesCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers device text after the audio grace window and attaches compressed audio", async () => {
    const orchestrator = createOrchestrator();
    const { call, updates } = createCall({ orchestrator });

    call.receive({ utteranceId: "u1", text: "¿cómo va auth?" });
    await vi.advanceTimersByTimeAsync(2_600);

    expect(orchestrator.requests).toEqual(["¿cómo va auth?"]);
    const reply = call.sync(0).find((item) => item.kind === "reply");
    expect(reply).toMatchObject({ text: "Respuesta a: ¿cómo va auth?", utteranceId: "u1" });
    expect(reply?.audio).toEqual({ mimeType: "audio/mpeg", size: expect.any(Number) });
    expect(updates.map((item) => item.kind)).toEqual(["heard", "reply", "reply"]);
    const audio = call.readAudio(reply!.seq, 0, 4);
    expect(audio?.audio.toString()).toBe("mp3:");
    expect(audio?.total).toBe(Buffer.from("mp3:Respuesta a: ¿cómo va auth?").length);
  });

  it("prefers the host transcription when the whole recording arrives", async () => {
    const orchestrator = createOrchestrator();
    const { call } = createCall({ orchestrator, transcribed: "cómo va security" });

    call.receive({ utteranceId: "u1", text: "como va secu ritty" });
    call.receive({
      utteranceId: "u1",
      chunkIndex: 0,
      chunkCount: 1,
      audio: Buffer.from("aac").toString("base64"),
      mimeType: "audio/mp4",
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(orchestrator.requests).toEqual(["cómo va security"]);
  });

  it("processes a retried utterance once", async () => {
    const orchestrator = createOrchestrator();
    const { call } = createCall({ orchestrator });

    call.receive({ utteranceId: "u1", text: "hola" });
    await vi.advanceTimersByTimeAsync(2_600);
    call.receive({ utteranceId: "u1", text: "hola" });
    await vi.advanceTimersByTimeAsync(2_600);

    expect(orchestrator.requests).toEqual(["hola"]);
  });

  it("reports an utterance it could not hear", async () => {
    const orchestrator = createOrchestrator();
    const { call } = createCall({ orchestrator });

    call.receive({
      utteranceId: "u1",
      chunkIndex: 0,
      chunkCount: 1,
      audio: Buffer.from("aac").toString("base64"),
      mimeType: "audio/mp4",
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(call.sync(0)).toMatchObject([{ kind: "status", code: "not_heard" }]);
    expect(orchestrator.requests).toEqual([]);
  });

  it("narrates notices and pushes the ones the phone has not picked up", async () => {
    const orchestrator = createOrchestrator();
    const pushes: unknown[] = [];
    const { call } = createCall({ orchestrator, pushes });

    orchestrator.call?.announce?.(["auth · Fix login finished."]);
    await vi.advanceTimersByTimeAsync(10);
    expect(call.sync(0)).toMatchObject([{ seq: 1, kind: "notice", text: "auth terminó." }]);
    call.sync(1);

    orchestrator.call?.announce?.(["security · Audit finished."]);
    await vi.advanceTimersByTimeAsync(10_500);

    expect(pushes).toEqual([
      {
        title: "Paseo",
        body: "auth terminó.",
        data: { voiceMessages: { callId: "call-1", seq: 2 } },
      },
    ]);
  });
});
