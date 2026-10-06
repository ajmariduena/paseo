import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import type {
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
} from "../../speech-provider.js";
import { createElevenLabsRealtimeSession } from "./realtime-stt-session.js";

interface FakeScribe {
  baseUrl: string;
  request: Promise<IncomingMessage>;
  socket: Promise<WebSocket>;
  received: Array<Record<string, unknown>>;
  nextMessage(): Promise<Record<string, unknown>>;
}

let server: WebSocketServer | null = null;
const sessions: StreamingTranscriptionSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function startFakeScribe(
  greeting: Record<string, unknown> = { message_type: "session_started", session_id: "s1" },
): Promise<FakeScribe> {
  const received: Array<Record<string, unknown>> = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  let resolveRequest!: (req: IncomingMessage) => void;
  let resolveSocket!: (socket: WebSocket) => void;
  const request = new Promise<IncomingMessage>((resolve) => (resolveRequest = resolve));
  const socket = new Promise<WebSocket>((resolve) => (resolveSocket = resolve));

  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (ws, req) => {
    resolveRequest(req);
    resolveSocket(ws);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else received.push(message);
    });
    ws.send(JSON.stringify(greeting));
  });
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    request,
    socket,
    received,
    nextMessage() {
      const queued = received.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function openSession(baseUrl: string, language = "es"): StreamingTranscriptionSession {
  const session = createElevenLabsRealtimeSession({
    apiKey: "xi-test",
    baseUrl,
    model: "scribe_v2_realtime",
    language,
    logger: pino({ level: "silent" }),
  });
  sessions.push(session);
  return session;
}

function nextFinal(session: StreamingTranscriptionSession): Promise<StreamingTranscriptionEvent> {
  return new Promise((resolve, reject) => {
    session.on("transcript", (event) => {
      if (event.isFinal) resolve(event);
    });
    session.on("error", reject);
  });
}

const tenthOfSecond = Buffer.alloc(3200, 1);

function transcriptsOf(events: StreamingTranscriptionEvent[]): string[] {
  return events.map((event) => event.transcript);
}

function segmentTranscriptsOf(events: StreamingTranscriptionEvent[]): string[][] {
  return events.map((event) => [event.segmentId, event.transcript]);
}

function messagesOf(errors: unknown[]): string[] {
  return errors.map((error) => (error as Error).message);
}

describe("createElevenLabsRealtimeSession", () => {
  test("connects with the realtime model, manual commits, PCM 16 kHz, language and API key", async () => {
    const fake = await startFakeScribe();
    await openSession(fake.baseUrl).connect();

    const req = await fake.request;
    const url = new URL(req.url ?? "", "ws://localhost");
    expect(url.pathname).toBe("/v1/speech-to-text/realtime");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_id: "scribe_v2_realtime",
      audio_format: "pcm_16000",
      commit_strategy: "manual",
      language_code: "es",
    });
    expect(req.headers["xi-api-key"]).toBe("xi-test");
  });

  test("streams audio as it arrives and settles a commit with the committed transcript", async () => {
    const fake = await startFakeScribe();
    const session = openSession(fake.baseUrl);
    const committed: StreamingTranscriptionCommittedEvent[] = [];
    const partials: StreamingTranscriptionEvent[] = [];
    session.on("committed", (event) => committed.push(event));
    session.on("transcript", (event) => {
      if (!event.isFinal) partials.push(event);
    });
    await session.connect();

    session.appendPcm16(tenthOfSecond);
    expect(await fake.nextMessage()).toEqual({
      message_type: "input_audio_chunk",
      audio_base_64: tenthOfSecond.toString("base64"),
      commit: false,
      sample_rate: 16000,
    });

    const ws = await fake.socket;
    ws.send(JSON.stringify({ message_type: "partial_transcript", text: "Hola" }));
    await expect.poll(() => transcriptsOf(partials)).toEqual(["Hola"]);

    const final = nextFinal(session);
    session.commit();
    expect(await fake.nextMessage()).toMatchObject({ audio_base_64: "", commit: true });
    ws.send(
      JSON.stringify({ message_type: "committed_transcript", text: " Hola, revisa el daemon. " }),
    );

    const event = await final;
    expect(event).toMatchObject({ transcript: "Hola, revisa el daemon.", isFinal: true });
    expect(committed).toEqual([{ segmentId: event.segmentId, previousSegmentId: null }]);
    expect(partials[0]?.segmentId).toBe(event.segmentId);
  });

  test("holds back buffers under 100 ms and sends them with the commit", async () => {
    const fake = await startFakeScribe();
    const session = openSession(fake.baseUrl);
    await session.connect();

    const nativeBuffer = Buffer.alloc(1024, 2);
    session.appendPcm16(nativeBuffer);
    session.commit();

    expect(await fake.nextMessage()).toMatchObject({
      audio_base_64: nativeBuffer.toString("base64"),
      commit: true,
    });
    expect(fake.received).toEqual([]);
  });

  test("maps committed transcripts to commits in the order they were sent", async () => {
    const fake = await startFakeScribe();
    const session = openSession(fake.baseUrl);
    const finals: StreamingTranscriptionEvent[] = [];
    const committed: string[] = [];
    session.on("committed", (event) => committed.push(event.segmentId));
    session.on("transcript", (event) => {
      if (event.isFinal) finals.push(event);
    });
    await session.connect();

    session.appendPcm16(tenthOfSecond);
    session.commit();
    session.appendPcm16(tenthOfSecond);
    session.commit();

    const ws = await fake.socket;
    ws.send(JSON.stringify({ message_type: "committed_transcript", text: "primero" }));
    ws.send(JSON.stringify({ message_type: "committed_transcript", text: "segundo" }));

    await expect
      .poll(() => segmentTranscriptsOf(finals))
      .toEqual([
        [committed[0], "primero"],
        [committed[1], "segundo"],
      ]);
  });

  test("a commit with no audio settles empty without a round trip", async () => {
    const fake = await startFakeScribe();
    const session = openSession(fake.baseUrl);
    await session.connect();

    const final = nextFinal(session);
    session.commit();

    expect(await final).toMatchObject({ transcript: "", isFinal: true });
    expect(fake.received).toEqual([]);
  });

  test("clear settles streamed audio server-side and drops its text", async () => {
    const fake = await startFakeScribe();
    const session = openSession(fake.baseUrl);
    const committed: string[] = [];
    const finals: StreamingTranscriptionEvent[] = [];
    session.on("committed", (event) => committed.push(event.segmentId));
    session.on("transcript", (event) => {
      if (event.isFinal) finals.push(event);
    });
    await session.connect();

    session.appendPcm16(tenthOfSecond);
    await fake.nextMessage();
    session.clear();
    expect(await fake.nextMessage()).toMatchObject({ commit: true });

    session.appendPcm16(tenthOfSecond);
    session.commit();
    const ws = await fake.socket;
    ws.send(JSON.stringify({ message_type: "committed_transcript", text: "ruido" }));
    ws.send(JSON.stringify({ message_type: "committed_transcript", text: "real" }));

    await expect.poll(() => transcriptsOf(finals)).toEqual(["real"]);
    expect(committed).toHaveLength(1);
  });

  test("rejects connect when Scribe answers with an auth error", async () => {
    const fake = await startFakeScribe({ message_type: "auth_error", error: "Invalid API key" });

    await expect(openSession(fake.baseUrl).connect()).rejects.toThrow(
      "ElevenLabs realtime transcription failed (auth_error): Invalid API key",
    );
  });

  test("surfaces a mid-session error event", async () => {
    const fake = await startFakeScribe();
    const session = openSession(fake.baseUrl);
    const errors: unknown[] = [];
    session.on("error", (error) => errors.push(error));
    await session.connect();

    const ws = await fake.socket;
    ws.send(JSON.stringify({ message_type: "quota_exceeded", error: "Out of credits" }));

    await expect
      .poll(() => messagesOf(errors))
      .toContain("ElevenLabs realtime transcription failed (quota_exceeded): Out of credits");
  });
});
