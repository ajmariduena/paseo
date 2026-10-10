import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPersistedConfig, savePersistedConfig } from "../../persisted-config.js";
import { resolveVoiceBrain } from "./brain-catalog.js";
import { FastBrain } from "./fast-brain.js";
import { VoiceCommandsService } from "./voice-commands-service.js";

const logger = pino({ level: "silent" });

interface FakeEndpoint {
  baseUrl: string;
  requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }>;
  reply: { status: number; toolCalls: boolean };
  close: () => Promise<void>;
}

/** A local OpenAI-compatible chat endpoint, like a model served on the user's network. */
async function startEndpoint(): Promise<FakeEndpoint> {
  const endpoint: FakeEndpoint = {
    baseUrl: "",
    requests: [],
    reply: { status: 200, toolCalls: true },
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    if (req.method === "GET") {
      res.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      endpoint.requests.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      res.statusCode = endpoint.reply.status;
      res.setHeader("Content-Type", "application/json");
      if (endpoint.reply.status !== 200) {
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
        return;
      }
      const toolCalls = endpoint.reply.toolCalls
        ? [{ id: "t1", type: "function", function: { name: "read_fleet", arguments: "{}" } }]
        : undefined;
      res.end(
        JSON.stringify({
          choices: [{ message: { content: toolCalls ? null : "Nothing.", tool_calls: toolCalls } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  endpoint.baseUrl = `http://127.0.0.1:${port}/v1`;
  endpoint.close = () => new Promise((resolve) => server.close(() => resolve()));
  return endpoint;
}

describe("VoiceCommandsService", () => {
  let paseoHome: string;
  let endpoint: FakeEndpoint;
  let brain: FastBrain;
  let service: VoiceCommandsService;

  beforeEach(async () => {
    paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-voice-commands-"));
    endpoint = await startEndpoint();
    brain = new FastBrain(logger);
    service = new VoiceCommandsService({ paseoHome, env: {}, brain, logger });
  });

  afterEach(async () => {
    await endpoint.close();
    rmSync(paseoHome, { recursive: true, force: true });
  });

  it("suggests the fastest model and answers with the agent until a key is added", () => {
    const settings = service.settings();
    expect(settings.selection).toEqual({ provider: "cerebras", model: "qwen-3.8-27b" });
    expect(settings.backup).toEqual({ provider: "openai", model: "gpt-6-luna" });
    expect(settings.active).toBeNull();
    expect(settings.options.some((option) => option.provider === "groq")).toBe(true);
    expect(brain.available).toBe(false);
  });

  it("saves a key without sending it back, and uses it at once", () => {
    const settings = service.setKey({ provider: "groq", apiKey: " gsk-test " });
    expect(JSON.stringify(settings)).not.toContain("gsk-test");
    expect(settings.providers.find((provider) => provider.id === "groq")?.hasKey).toBe(true);
    expect(loadPersistedConfig(paseoHome).providers?.groq?.apiKey).toBe("gsk-test");

    const chosen = service.setModel({
      selection: { provider: "groq", model: "openai/gpt-oss-20b" },
    });
    expect(chosen.active).toEqual({ provider: "groq", model: "openai/gpt-oss-20b" });
    expect(brain.available).toBe(true);

    const removed = service.setKey({ provider: "groq", apiKey: null });
    expect(removed.active).toBeNull();
    expect(loadPersistedConfig(paseoHome).providers?.groq).toBeUndefined();
  });

  it("runs a custom endpoint end to end and measures it", async () => {
    service.setModel({
      customBaseUrl: endpoint.baseUrl,
      selection: { provider: "custom", model: "local-router" },
      backup: null,
    });

    const result = await service.test("selection");

    expect(result.ok).toBe(true);
    expect(result.roundTripMs).toEqual(expect.any(Number));
    expect(result.settings.lastRoundTripMs).toBe(result.roundTripMs);
    expect(endpoint.requests.at(-1)?.authorization).toBeUndefined();
    expect(endpoint.requests.at(-1)?.body).toMatchObject({
      model: "local-router",
      tool_choice: "required",
    });

    service.setKey({ provider: "custom", apiKey: "secret" });
    await service.test("selection");
    expect(endpoint.requests.at(-1)?.authorization).toBe("Bearer secret");
  });

  it("reports a model that rejects the key or skips the tools", async () => {
    service.setModel({
      customBaseUrl: endpoint.baseUrl,
      selection: { provider: "custom", model: "local-router" },
    });
    endpoint.reply = { status: 401, toolCalls: true };
    expect(await service.test("selection")).toMatchObject({
      ok: false,
      roundTripMs: null,
      error: "Invalid API key",
    });

    endpoint.reply = { status: 200, toolCalls: false };
    expect(await service.test("selection")).toMatchObject({
      ok: false,
      error: "The model answered without using a tool",
    });
  });

  it("turns the fast model off and keeps the choice across restarts", () => {
    service.setModel({ selection: null, backup: null });
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.features?.voiceMode?.router).toEqual({ provider: "off", backup: false });
    const resolved = resolveVoiceBrain({ env: {}, persisted });
    expect(resolved.selection).toBeNull();
    expect(resolved.backup).toBeNull();
  });

  it("rejects models the provider does not have and custom models without an endpoint", () => {
    expect(() =>
      service.setModel({ selection: { provider: "cerebras", model: "made-up" } }),
    ).toThrow("Cerebras has no model made-up");
    expect(() =>
      service.setModel({ selection: { provider: "custom", model: "local-router" } }),
    ).toThrow("Set the endpoint URL first");
    expect(() => service.setModel({ customBaseUrl: "ftp://nope" })).toThrow("http or https");
    expect(loadPersistedConfig(paseoHome).features).toBeUndefined();
  });

  it("keeps other config untouched", () => {
    savePersistedConfig(paseoHome, {
      features: { dictation: { stt: { language: "es" } } },
      providers: { openai: { apiKey: "sk-openai" } },
    });
    service.setKey({ provider: "cerebras", apiKey: "csk" });
    service.setModel({ selection: { provider: "cerebras", model: "gpt-oss-120b" } });
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.features?.dictation).toEqual({ stt: { language: "es" } });
    expect(persisted.providers?.openai?.apiKey).toBe("sk-openai");
    expect(service.settings().backup).toEqual({ provider: "openai", model: "gpt-6-luna" });
  });
});
