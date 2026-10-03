import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { SessionOutboundMessage } from "../../messages.js";
import type { VoiceOrchestrator } from "../orchestrator.js";
import { GptLiveCall } from "./live-call.js";
import { GptLiveConnection, createGptLiveWebrtcSession } from "./live-connection.js";

type LiveMessage = Record<string, unknown>;

interface FakeLive {
  url: string;
  paths: string[];
  received: LiveMessage[];
  socket: () => WebSocket;
  close: () => Promise<void>;
}

function replyToClient(socket: WebSocket, received: LiveMessage[], data: RawData): void {
  const message = JSON.parse(data.toString()) as LiveMessage;
  received.push(message);
  if (message.type === "session.start") {
    socket.send(JSON.stringify({ type: "session.started", session: { id: "sess_1" } }));
  }
  if (message.type === "session.close") {
    socket.send(JSON.stringify({ type: "session.closed", usage: { seconds: 1 } }));
  }
}

async function startFakeLive(): Promise<FakeLive> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const received: LiveMessage[] = [];
  let current: WebSocket | null = null;
  const paths: string[] = [];
  server.on("connection", (socket, request) => {
    expect(request.headers.authorization).toBe("Bearer test-key");
    paths.push(request.url ?? "");
    current = socket;
    socket.on("message", (data) => replyToClient(socket, received, data));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}`,
    paths,
    received,
    socket: () => {
      if (!current) throw new Error("no connection");
      return current;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function findMessage(
  live: FakeLive,
  type: string,
  delegationId?: string | null,
): LiveMessage | undefined {
  return live.received.find(
    (message) =>
      message.type === type &&
      (delegationId === undefined || message.delegation_id === delegationId),
  );
}

function hasOutput(
  emitted: SessionOutboundMessage[],
  type: SessionOutboundMessage["type"],
  lastChunk = false,
): boolean {
  return emitted.some(
    (message) =>
      message.type === type &&
      (!lastChunk || (message.type === "audio_output" && message.payload.isLastChunk === true)),
  );
}

function createOrchestratorStub() {
  const calls: Array<{ request: string; history: string[] }> = [];
  const utterances: string[] = [];
  let announce: ((lines: string[]) => void) | undefined;
  const stub = {
    language: "es",
    describeFleet: async () => [{ workspace: "auth", title: "Login fix", status: "working" }],
    attachCall: (call: { announce?: (lines: string[]) => void }) => {
      announce = call.announce;
      return () => {
        announce = undefined;
      };
    },
    noteUserUtterance: (text: string) => utterances.push(text),
    takeRecentHistory: () => [],
    saveCallHistory: () => undefined,
    registerLiveCall: () => () => undefined,
    runDelegation: async (params: { request: string; history: string[] }) => {
      calls.push(params);
      return "Auth sigue trabajando en el login.";
    },
  };
  return {
    orchestrator: stub as unknown as VoiceOrchestrator,
    calls,
    utterances,
    announce: (lines: string[]) => announce?.(lines),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GptLiveCall", () => {
  let activeLive: FakeLive | null = null;
  let call: GptLiveCall | null = null;

  afterEach(async () => {
    call?.close();
    call = null;
    await activeLive?.close();
    activeLive = null;
  });

  async function startCall() {
    const live = await startFakeLive();
    activeLive = live;
    const stub = createOrchestratorStub();
    const emitted: SessionOutboundMessage[] = [];
    call = new GptLiveCall({
      engine: { apiKey: "test-key", model: "gpt-live-1", voice: "marin" },
      orchestrator: stub.orchestrator,
      emit: (message) => emitted.push(message),
      logger: pino({ level: "silent" }),
      createConnection: () => new GptLiveConnection(live.url),
    });
    await call.start();
    return { live, stub, emitted };
  }

  it("starts a client-delegation session at 16 kHz and greets with the fleet", async () => {
    const { live } = await startCall();
    expect(findMessage(live, "session.start")?.session).toMatchObject({
      model: "gpt-live-1",
      audio: { format: { type: "audio/pcm", rate: 16000 }, output: { voice: "marin" } },
      delegation: { type: "client" },
    });
    await waitFor(() => findMessage(live, "session.instructions.append") !== undefined);
    expect(findMessage(live, "session.instructions.append")?.content).toContain(
      "auth · Login fix: working",
    );
    expect(findMessage(live, "session.thinking.append")?.content).toContain(
      "auth · Login fix: working",
    );
  });

  it("forwards microphone audio and returns speech as audio_output groups", async () => {
    const { live, emitted } = await startCall();
    call!.appendAudio(Buffer.alloc(320));
    await waitFor(() => findMessage(live, "session.input_audio.append") !== undefined);

    const speech = Buffer.alloc(16000 * 2).toString("base64");
    live.socket().send(JSON.stringify({ type: "session.output_audio.delta", delta: speech }));
    await waitFor(() => hasOutput(emitted, "audio_output", true));
    const audio = emitted.filter((message) => message.type === "audio_output");
    expect(audio[0]).toMatchObject({
      payload: { format: "pcm;rate=16000", chunkIndex: 0, isVoiceMode: true },
    });
    const groups = new Set(audio.map((message) => message.payload.groupId));
    expect(groups.size).toBe(1);
  });

  it("runs a delegation with the user's words and returns the result as commentary", async () => {
    const { live, stub, emitted } = await startCall();
    live
      .socket()
      .send(JSON.stringify({ type: "session.input_transcript.delta", delta: "¿Cómo va auth?" }));
    await waitFor(() => hasOutput(emitted, "voice_input_state"));
    live.socket().send(
      JSON.stringify({
        type: "session.delegation.created",
        delegation: { id: "item_1", type: "delegation", target: "client" },
      }),
    );
    await waitFor(() => findMessage(live, "session.commentary.append", "item_1") !== undefined);
    expect(stub.calls[0]?.request).toBe("¿Cómo va auth?");
    expect(stub.utterances).toContain("¿Cómo va auth?");
    expect(findMessage(live, "session.commentary.append", "item_1")?.content).toBe(
      "Auth sigue trabajando en el login.",
    );
  });

  it("speaks daemon notices as session commentary", async () => {
    const { live, stub } = await startCall();
    stub.announce(["auth · Login fix finished."]);
    await waitFor(() => findMessage(live, "session.commentary.append", null) !== undefined);
  });

  it("attaches to a WebRTC session as a sideband and greets once the phone's audio arrives", async () => {
    const live = await startFakeLive();
    activeLive = live;
    const stub = createOrchestratorStub();
    const emitted: SessionOutboundMessage[] = [];
    call = new GptLiveCall({
      engine: { apiKey: "test-key", model: "gpt-live-1", voice: "marin" },
      orchestrator: stub.orchestrator,
      emit: (message) => emitted.push(message),
      logger: pino({ level: "silent" }),
      sidebandSessionId: "live_123",
      createConnection: () => new GptLiveConnection(live.url),
    });
    await call.start();

    expect(live.paths).toEqual(["/live_123/attach"]);
    await waitFor(() => findMessage(live, "session.thinking.append") !== undefined);
    expect(findMessage(live, "session.start")).toBeUndefined();
    expect(findMessage(live, "session.instructions.append")).toBeUndefined();

    live.socket().send(JSON.stringify({ type: "session.input_audio.append", audio: "AAAA" }));
    live.socket().send(
      JSON.stringify({
        type: "session.output_audio.delta",
        delta: Buffer.alloc(32000).toString("base64"),
      }),
    );
    await waitFor(() => findMessage(live, "session.instructions.append") !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(hasOutput(emitted, "audio_output")).toBe(false);
  });
});

describe("createGptLiveWebrtcSession", () => {
  it("trades the phone's offer for the answer with a client-delegation session", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        auth: new Headers(init.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify({
          session: { id: "live_9" },
          transport: { type: "webrtc", sdp: "v=0 answer" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const answer = await createGptLiveWebrtcSession({
      apiKey: "test-key",
      model: "gpt-live-1",
      voice: "marin",
      instructions: "Habla español.",
      sdp: "v=0 offer",
      fetchImpl,
    });

    expect(answer).toEqual({ sessionId: "live_9", sdp: "v=0 answer" });
    expect(requests[0]).toEqual({
      url: "https://api.openai.com/v1/live/sessions",
      auth: "Bearer test-key",
      body: {
        session: {
          model: "gpt-live-1",
          instructions: "Habla español.",
          audio: { output: { voice: "marin" } },
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp: "v=0 offer" },
      },
    });
  });

  it("reports OpenAI's error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "no access" } }), {
        status: 403,
      })) as unknown as typeof fetch;

    await expect(
      createGptLiveWebrtcSession({
        apiKey: "k",
        model: "gpt-live-1",
        voice: "marin",
        instructions: "",
        sdp: "v=0",
        fetchImpl,
      }),
    ).rejects.toThrow("GPT-Live WebRTC session failed (403): no access");
  });
});
