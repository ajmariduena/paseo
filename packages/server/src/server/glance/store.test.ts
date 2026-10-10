import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent/agent-manager.js";
import { GlanceSummaryService, type GlanceSummaryServiceOptions } from "./service.js";
import { GlanceStore } from "./store.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "paseo-glance-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function createService(overrides: Partial<GlanceSummaryServiceOptions> = {}) {
  const generate = vi.fn(async () => [{ id: "0", line: "Terminé el cambio." }]);
  const service = new GlanceSummaryService({
    agentManager: {} as AgentManager,
    providerSnapshotManager: { listProviders: async () => [] },
    getConfig: () => ({ metadataGeneration: { providers: [{ provider: "claude" }] } }),
    logger: pino({ level: "silent" }),
    store: GlanceStore.forPaseoHome(home),
    generateStructured: async (input) => {
      const result = await generate();
      if (!("parse" in input.schema) || typeof input.schema.parse !== "function")
        throw new Error("Expected Zod schema");
      return input.schema.parse(result);
    },
    ...overrides,
  });
  return { service, generate };
}

const assistant = { id: "a", role: "assistant" as const, text: "Terminé de implementar el cambio" };

describe("glance persistence", () => {
  it("restores cached summaries after a restart without calling the provider", async () => {
    const first = createService({ persistDelayMs: 60_000 });
    await first.service.load();
    await first.service.summarize({ items: [assistant], cwd: "/repo" });
    await first.service.flush();
    expect(
      JSON.parse(await readFile(path.join(home, "glance", "summaries.json"), "utf8")),
    ).toMatchObject({ version: 1, entries: [[expect.any(String), "Terminé el cambio."]] });

    const restarted = createService();
    await restarted.service.load();
    expect(restarted.service.getCachedLine("assistant", assistant.text)).toBe("Terminé el cambio.");
    expect(
      await restarted.service.summarize({ items: [{ ...assistant, id: "b" }], cwd: "/repo" }),
    ).toEqual([{ id: "b", line: "Terminé el cambio." }]);
    expect(restarted.generate).not.toHaveBeenCalled();
  });

  it("keeps at most cacheSize entries on disk, least recently used first", async () => {
    const { service, generate } = createService({ cacheSize: 2, persistDelayMs: 60_000 });
    for (const text of ["A", "B", "C"]) {
      generate.mockResolvedValueOnce([{ id: "0", line: `Línea ${text}.` }]);
      await service.summarize({ items: [{ ...assistant, text }], cwd: "/repo" });
    }
    await service.flush();
    const stored = await GlanceStore.forPaseoHome(home).readSummaries();
    expect(stored.map(([, line]) => line)).toEqual(["Línea B.", "Línea C."]);
  });

  it("persists glasses mode once and keeps it across restarts", async () => {
    const first = createService();
    await first.service.load();
    expect(first.service.isGlassesMode()).toBe(false);
    await first.service.enableGlassesMode();
    const state = JSON.parse(await readFile(path.join(home, "glance", "state.json"), "utf8"));
    expect(state).toEqual({ version: 1, glassesPairedAt: expect.any(String) });
    await first.service.enableGlassesMode();
    expect(JSON.parse(await readFile(path.join(home, "glance", "state.json"), "utf8"))).toEqual(
      state,
    );

    const restarted = createService();
    await restarted.service.load();
    expect(restarted.service.isGlassesMode()).toBe(true);
  });

  it("starts empty when the glance files are missing or corrupt", async () => {
    await mkdir(path.join(home, "glance"), { recursive: true });
    await writeFile(path.join(home, "glance", "summaries.json"), "{not json");
    await writeFile(path.join(home, "glance", "state.json"), JSON.stringify({ version: 2 }));
    const { service } = createService();
    await service.load();
    expect(service.isGlassesMode()).toBe(false);
    expect(service.getCachedLine("assistant", assistant.text)).toBeUndefined();
  });
});
