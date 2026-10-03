import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { CallTranscript } from "./call-transcript.js";

describe("CallTranscript", () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it("appends every event as JSONL and renders a readable Markdown record at the end", async () => {
    directory = await mkdtemp(join(tmpdir(), "voice-calls-"));
    const transcript = new CallTranscript({
      directory,
      callId: "live_1234567890",
      mode: "live-webrtc",
      logger: pino({ level: "silent" }),
    });
    transcript.record("user", "¿Cómo va auth?");
    transcript.record("delegation", "¿Cómo va auth?");
    transcript.record("result", "Auth terminó y dejó el PR listo.");
    transcript.record("assistant", "Auth terminó y dejó el PR listo.");
    transcript.record("notice", "security · Audit finished.", { urgent: false });
    await transcript.close();

    const [day] = await readdir(directory);
    const files = (await readdir(join(directory, day!))).sort();
    expect(files.map((file) => file.replace(/^\d{6}-/, ""))).toEqual([
      "live-webrtc-live_123.jsonl",
      "live-webrtc-live_123.md",
    ]);
    const lines = (await readFile(join(directory, day!, files[0]!), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
      "call_started",
      "user",
      "delegation",
      "result",
      "assistant",
      "notice",
      "call_ended",
    ]);
    const markdown = await readFile(transcript.path, "utf8");
    expect(markdown).toContain("Modo: live-webrtc");
    expect(markdown).toMatch(/\*\*\d\d:\d\d:\d\d Tú:\*\* ¿Cómo va auth\?/);
    expect(markdown).toMatch(/> \d\d:\d\d:\d\d · Aviso: security · Audit finished\./);
  });
});
