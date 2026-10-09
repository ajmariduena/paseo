import { createServer, type Server } from "node:http";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FastBrain } from "./fast-brain.js";
import type { FastLlmConfig } from "./llm-client.js";

const logger = pino({ level: "silent" });

interface Endpoint {
  config: (model: string) => FastLlmConfig;
  hits: number;
  mode: "answer" | "fail" | "stall";
  close: () => Promise<void>;
}

async function startEndpoint(text: string): Promise<Endpoint> {
  const endpoint: Endpoint = {
    config: () => {
      throw new Error("not started");
    },
    hits: 0,
    mode: "answer",
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      endpoint.hits += 1;
      if (endpoint.mode === "stall") return;
      if (endpoint.mode === "fail") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: "Overloaded" } }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  endpoint.config = (model) => ({
    provider: "custom",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "",
    model,
    reasoningEffort: null,
  });
  endpoint.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return endpoint;
}

describe("FastBrain", () => {
  let primary: Endpoint;
  let backup: Endpoint;

  beforeEach(async () => {
    primary = await startEndpoint("from the model");
    backup = await startEndpoint("from the backup");
  });

  afterEach(async () => {
    await primary.close();
    await backup.close();
  });

  const ask = (brain: FastBrain, timeoutMs?: number) =>
    brain.complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 10, timeoutMs });

  it("answers with the model and records its round trip", async () => {
    const brain = new FastBrain(logger);
    brain.configure({ primary: primary.config("fast"), backup: backup.config("slow") });
    expect((await ask(brain)).content).toBe("from the model");
    expect(brain.roundTrip).toMatchObject({ model: "fast", ms: expect.any(Number) });
    expect(backup.hits).toBe(0);
  });

  it("falls back when the model fails or stalls", async () => {
    const brain = new FastBrain(logger);
    brain.configure({ primary: primary.config("fast"), backup: backup.config("slow") });
    primary.mode = "fail";
    expect((await ask(brain)).content).toBe("from the backup");
    primary.mode = "stall";
    expect((await ask(brain, 200)).content).toBe("from the backup");
    expect(brain.roundTrip?.model).toBe("slow");
  });

  it("uses the backup alone while the model has no key", async () => {
    const brain = new FastBrain(logger);
    brain.configure({ primary: null, backup: backup.config("slow") });
    expect(brain.available).toBe(true);
    expect((await ask(brain)).content).toBe("from the backup");
  });

  it("switches models without a restart", async () => {
    const brain = new FastBrain(logger);
    expect(brain.available).toBe(false);
    await expect(ask(brain)).rejects.toThrow("No fast model");
    brain.configure({ primary: backup.config("other"), backup: null });
    expect((await ask(brain)).content).toBe("from the backup");
  });

  it("does not try the backup when the request was cancelled", async () => {
    const brain = new FastBrain(logger);
    brain.configure({ primary: primary.config("fast"), backup: backup.config("slow") });
    primary.mode = "stall";
    const controller = new AbortController();
    const pending = brain.complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    expect(backup.hits).toBe(0);
  });
});
