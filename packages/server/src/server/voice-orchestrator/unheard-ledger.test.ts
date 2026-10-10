import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnheardLedger } from "./unheard-ledger.js";

const HOUR = 60 * 60 * 1000;

describe("UnheardLedger", () => {
  let dir: string;
  let now: number;
  let ledgers: UnheardLedger[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unheard-"));
    now = 1_000_000;
    ledgers = [];
  });

  afterEach(async () => {
    // A write still in flight keeps a file in the directory, and Windows refuses to remove it.
    await Promise.all(ledgers.map((ledger) => ledger.flushed()));
    await rm(dir, { recursive: true, force: true });
  });

  function createLedger(): UnheardLedger {
    const ledger = new UnheardLedger({
      path: join(dir, "voice", "unheard.json"),
      ttlMs: 12 * HOUR,
      logger: pino({ level: "silent" }),
      now: () => now,
    });
    ledgers.push(ledger);
    return ledger;
  }

  it("keeps the most urgent reason for an agent and lists urgent first", () => {
    const ledger = createLedger();
    ledger.add("a", "finished");
    ledger.add("b", "permission");
    ledger.add("b", "finished");
    expect(ledger.list().map((entry) => [entry.agentId, entry.reason])).toEqual([
      ["b", "permission"],
      ["a", "finished"],
    ]);
  });

  it("removes an entry only while it is still about the given reason", () => {
    const ledger = createLedger();
    ledger.add("a", "error");
    ledger.remove("a", "finished");
    expect(ledger.has("a")).toBe(true);
    ledger.remove("a", "error");
    expect(ledger.has("a")).toBe(false);
  });

  it("forgets results older than its time to live", () => {
    const ledger = createLedger();
    ledger.add("a", "finished");
    now += 13 * HOUR;
    expect(ledger.has("a")).toBe(false);
    expect(ledger.list()).toEqual([]);
  });

  it("survives a restart through its file", async () => {
    const first = createLedger();
    first.add("a", "finished");
    first.add("b", "error");
    first.remove("b");
    await first.flushed();
    expect(JSON.parse(await readFile(join(dir, "voice", "unheard.json"), "utf8"))).toEqual({
      entries: [{ agentId: "a", reason: "finished", at: now }],
    });

    const second = createLedger();
    await second.load();
    expect(second.has("a")).toBe(true);
    expect(second.has("b")).toBe(false);
  });
});
