import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { SpeechServices } from "../openai/runtime.js";
import { initializeElevenLabsSpeechServices } from "./runtime.js";
import { ElevenLabsTTS } from "./tts.js";

interface RecordedRequest {
  url: string | undefined;
  apiKey: string | undefined;
  body: Record<string, unknown>;
}

const logger = pino({ level: "silent" });

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function startFakeElevenLabs(
  audio: Buffer,
): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url,
        apiKey: req.headers["xi-api-key"] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      res.writeHead(200, { "Content-Type": "audio/pcm" });
      res.end(audio);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server!.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function requestedProviders(
  overrides: Partial<RequestedSpeechProviders> = {},
): RequestedSpeechProviders {
  const local = { provider: "local", explicit: false, enabled: true } as const;
  return {
    dictationStt: local,
    voiceTurnDetection: local,
    voiceStt: local,
    voiceTts: { provider: "elevenlabs", explicit: true, enabled: true },
    ...overrides,
  };
}

const emptyServices: SpeechServices = {
  turnDetectionService: null,
  sttService: null,
  ttsService: null,
  dictationSttService: null,
};

describe("ElevenLabsTTS", () => {
  test("synthesizes PCM speech with the configured voice, model and settings", async () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
    const { baseUrl, requests } = await startFakeElevenLabs(pcm);
    const tts = new ElevenLabsTTS(
      {
        apiKey: "xi-test",
        baseUrl,
        voiceId: "voice-123",
        model: "eleven_flash_v2_5",
        voiceSettings: { speed: 1.1 },
      },
      logger,
    );

    const result = await tts.synthesizeSpeech("Hola, ¿cómo estás?");

    expect(result.format).toBe("pcm;rate=24000");
    expect(await readAll(result.stream)).toEqual(pcm);
    expect(requests).toEqual([
      {
        url: "/v1/text-to-speech/voice-123?output_format=pcm_24000",
        apiKey: "xi-test",
        body: {
          text: "Hola, ¿cómo estás?",
          model_id: "eleven_flash_v2_5",
          voice_settings: { speed: 1.1 },
        },
      },
    ]);
  });

  test("rejects empty text without calling ElevenLabs", async () => {
    const tts = new ElevenLabsTTS(
      {
        apiKey: "xi-test",
        baseUrl: "http://127.0.0.1:1",
        voiceId: "voice-123",
        model: "eleven_flash_v2_5",
        voiceSettings: {},
      },
      logger,
    );

    await expect(tts.synthesizeSpeech("   ")).rejects.toThrow("Cannot synthesize empty text");
  });
});

describe("initializeElevenLabsSpeechServices voice TTS", () => {
  const voiceTts = { model: "eleven_flash_v2_5", voiceId: "voice-123", voiceSettings: {} };

  test("creates the ElevenLabs TTS service when voice TTS requests ElevenLabs", () => {
    const services = initializeElevenLabsSpeechServices({
      providers: requestedProviders(),
      elevenlabsConfig: { apiKey: "xi-test", baseUrl: "https://api.elevenlabs.io", voiceTts },
      existing: emptyServices,
      logger,
    });

    expect(services.ttsService).toBeInstanceOf(ElevenLabsTTS);
    expect(services.sttService).toBeNull();
  });

  test("leaves TTS unavailable when no voice id resolves", () => {
    const services = initializeElevenLabsSpeechServices({
      providers: requestedProviders(),
      elevenlabsConfig: {
        apiKey: "xi-test",
        baseUrl: "https://api.elevenlabs.io",
        voiceTts: { ...voiceTts, voiceId: null },
      },
      existing: emptyServices,
      logger,
    });

    expect(services.ttsService).toBeNull();
  });

  test("leaves TTS unavailable when no API key is set", () => {
    const services = initializeElevenLabsSpeechServices({
      providers: requestedProviders(),
      elevenlabsConfig: { apiKey: null, baseUrl: "https://api.elevenlabs.io", voiceTts },
      existing: emptyServices,
      logger,
    });

    expect(services.ttsService).toBeNull();
  });

  test("keeps a TTS service an earlier provider already set", () => {
    const existingTts = new ElevenLabsTTS(
      { apiKey: "xi-other", baseUrl: "https://api.elevenlabs.io", ...voiceTts, voiceId: "other" },
      logger,
    );
    const services = initializeElevenLabsSpeechServices({
      providers: requestedProviders(),
      elevenlabsConfig: { apiKey: "xi-test", baseUrl: "https://api.elevenlabs.io", voiceTts },
      existing: { ...emptyServices, ttsService: existingTts },
      logger,
    });

    expect(services.ttsService).toBe(existingTts);
  });
});
