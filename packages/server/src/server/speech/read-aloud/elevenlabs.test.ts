import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ElevenLabsError, synthesizeElevenLabsSpeech } from "./elevenlabs.js";

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  apiKey: string | undefined;
  body: Record<string, unknown>;
}

type Responder = (res: ServerResponse) => void;

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function startFakeElevenLabs(
  responders: Responder[],
): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        apiKey: req.headers["xi-api-key"] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      const respond = responders[Math.min(requests.length - 1, responders.length - 1)];
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function audio(requestId: string): Responder {
  return (res) => {
    res.writeHead(200, { "Content-Type": "audio/pcm", "request-id": requestId });
    res.end(Buffer.from([1, 2, 3, 4]));
  };
}

function failure(status: number, body: unknown, headers: Record<string, string> = {}): Responder {
  return (res) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
}

const noSleep = async () => {};

describe("synthesizeElevenLabsSpeech", () => {
  it("requests 24 kHz PCM for the configured voice and returns the audio with its request id", async () => {
    const fake = await startFakeElevenLabs([audio("req-4")]);

    const result = await synthesizeElevenLabsSpeech({
      apiKey: "key-123",
      baseUrl: fake.baseUrl,
      voiceId: "voice/1",
      model: "eleven_flash_v2_5",
      text: "Hola, terminé la tarea.",
      voiceSettings: { speed: 1.1, similarityBoost: 0.8 },
      previousRequestIds: ["req-0", "req-1", "req-2", "req-3"],
    });

    expect(result).toEqual({
      audio: Buffer.from([1, 2, 3, 4]),
      format: "pcm;rate=24000",
      requestId: "req-4",
    });
    expect(fake.requests).toEqual([
      {
        method: "POST",
        url: "/v1/text-to-speech/voice%2F1?output_format=pcm_24000",
        apiKey: "key-123",
        body: {
          text: "Hola, terminé la tarea.",
          model_id: "eleven_flash_v2_5",
          voice_settings: { speed: 1.1, similarity_boost: 0.8 },
          previous_request_ids: ["req-1", "req-2", "req-3"],
        },
      },
    ]);
  });

  it("retries rate limits and returns the audio once ElevenLabs accepts the request", async () => {
    const fake = await startFakeElevenLabs([
      failure(429, { detail: { code: "concurrent_limit_exceeded", message: "Too many" } }),
      audio("req-ok"),
    ]);

    const result = await synthesizeElevenLabsSpeech({
      apiKey: "key",
      baseUrl: fake.baseUrl,
      voiceId: "voice",
      model: "eleven_flash_v2_5",
      text: "Listo.",
      voiceSettings: {},
      sleep: noSleep,
    });

    expect(result.requestId).toBe("req-ok");
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1].body).toEqual({ text: "Listo.", model_id: "eleven_flash_v2_5" });
  });

  it("reports an account without credits without retrying", async () => {
    const fake = await startFakeElevenLabs([
      failure(402, {
        detail: { type: "payment_required", code: "insufficient_credits", message: "No credits" },
      }),
    ]);

    const request = synthesizeElevenLabsSpeech({
      apiKey: "key",
      baseUrl: fake.baseUrl,
      voiceId: "voice",
      model: "eleven_flash_v2_5",
      text: "Listo.",
      voiceSettings: {},
      sleep: noSleep,
    });

    await expect(request).rejects.toEqual(
      new ElevenLabsError(
        "ElevenLabs account has no credits left: No credits",
        402,
        "insufficient_credits",
      ),
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("explains a key without the text-to-speech permission", async () => {
    const fake = await startFakeElevenLabs([
      failure(401, {
        detail: {
          status: "missing_permissions",
          message: "The API key you used is missing the permission text_to_speech",
        },
      }),
    ]);

    const request = synthesizeElevenLabsSpeech({
      apiKey: "key",
      baseUrl: fake.baseUrl,
      voiceId: "voice",
      model: "eleven_flash_v2_5",
      text: "Listo.",
      voiceSettings: {},
    });

    await expect(request).rejects.toThrow(
      "ElevenLabs rejected the API key: The API key you used is missing the permission text_to_speech",
    );
  });
});
