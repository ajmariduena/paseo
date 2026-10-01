import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { StreamingTranscriptionEvent } from "../../speech-provider.js";
import { ElevenLabsSTT } from "./stt.js";

interface RecordedRequest {
  url: string | undefined;
  apiKey: string | undefined;
  form: FormData;
}

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function startFakeElevenLabs(
  respond: (res: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const form = await new Response(Buffer.concat(chunks), {
        headers: { "content-type": req.headers["content-type"] ?? "" },
      }).formData();
      requests.push({ url: req.url, apiKey: req.headers["xi-api-key"] as string, form });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server!.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function nextTranscript(session: ReturnType<ElevenLabsSTT["createSession"]>) {
  return new Promise<StreamingTranscriptionEvent>((resolve, reject) => {
    session.on("transcript", resolve);
    session.on("error", reject);
  });
}

describe("ElevenLabsSTT", () => {
  test("uploads each committed segment as 16 kHz WAV and returns the Scribe transcript", async () => {
    const fake = await startFakeElevenLabs((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: " Hola, revisa el daemon. ", language_code: "spa" }));
    });
    const provider = new ElevenLabsSTT(
      { apiKey: "xi-test", baseUrl: fake.baseUrl },
      pino({ level: "silent" }),
    );
    const session = provider.createSession({ logger: pino({ level: "silent" }), language: "es" });
    await session.connect();
    const transcript = nextTranscript(session);

    session.appendPcm16(Buffer.alloc(3200));
    session.commit();

    await expect(transcript).resolves.toMatchObject({
      transcript: "Hola, revisa el daemon.",
      isFinal: true,
      language: "spa",
    });
    expect(session.requiredSampleRate).toBe(16000);
    const [request] = fake.requests;
    expect(request.url).toBe("/v1/speech-to-text");
    expect(request.apiKey).toBe("xi-test");
    expect(request.form.get("model_id")).toBe("scribe_v2");
    expect(request.form.get("language_code")).toBe("es");
    const file = request.form.get("file") as File;
    expect(file.size).toBe(44 + 3200);
  });

  test("reports API failures as session errors", async () => {
    const fake = await startFakeElevenLabs((res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: { status: "missing_permissions" } }));
    });
    const provider = new ElevenLabsSTT(
      { apiKey: "xi-test", baseUrl: fake.baseUrl, model: "scribe_v1" },
      pino({ level: "silent" }),
    );
    const session = provider.createSession({ logger: pino({ level: "silent" }) });
    await session.connect();
    const transcript = nextTranscript(session);

    session.appendPcm16(Buffer.alloc(320));
    session.commit();

    await expect(transcript).rejects.toThrow(/401.*missing_permissions/);
    expect(fake.requests[0].form.get("model_id")).toBe("scribe_v1");
    expect(fake.requests[0].form.has("language_code")).toBe(false);
  });
});
