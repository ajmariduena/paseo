import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { HandoffAlreadyExistsError, HandoffStore, type HandoffFile } from "./handoff-store.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "handoffs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const NOW = "2026-10-09T12:00:00.000Z";

function handoff(id = "h1"): Omit<HandoffFile, "version"> {
  return {
    id,
    agentId: "agent-1",
    fromSegmentId: "seg-a",
    toSegmentId: "seg-b",
    toIncarnationId: "inc-b1",
    items: [
      {
        role: "user",
        kind: "user_message",
        text: "fix the tests",
        provenance: { type: "row", identity: { segmentId: "seg-a", rowIndex: 4 } },
        origin: { kind: "user" },
        status: "completed",
        rendered: "User: fix the tests",
      },
    ],
    omittedItems: [{ type: "row", identity: { segmentId: "seg-a", rowIndex: 1 } }],
    coverage: { text: "1 of 2 items", ranges: [], missing: [], collapsed: false },
    budget: {
      available: 16000,
      cap: 16000,
      contextWindow: 128000,
      unknownWindow: false,
      occupancy: 0,
      currentInput: 20,
      reserve: 32000,
    },
    cost: 240,
    delivery: { state: "unsent", attemptId: null, updatedAt: NOW },
    createdAt: NOW,
  };
}

test("a handoff is written once with its rendered items and provenance", async () => {
  const store = new HandoffStore(root);

  const created = await store.create(handoff());

  expect(created.version).toBe(1);
  expect(JSON.parse(readFileSync(join(root, "agent-1", "h1.json"), "utf8"))).toEqual(created);
  expect(await store.read("agent-1", "h1")).toEqual(created);
  await expect(store.create(handoff())).rejects.toBeInstanceOf(HandoffAlreadyExistsError);
  expect(await store.list("agent-1")).toEqual(["h1"]);
  expect(await store.listAgents()).toEqual(["agent-1"]);
});

test("only the delivery state changes after creation", async () => {
  const store = new HandoffStore(root);
  const created = await store.create(handoff());

  const accepted = await store.updateDelivery("agent-1", "h1", {
    state: "accepted",
    attemptId: "attempt-1",
    updatedAt: "2026-10-09T12:01:00.000Z",
  });

  expect(accepted).toEqual({
    ...created,
    delivery: { state: "accepted", attemptId: "attempt-1", updatedAt: "2026-10-09T12:01:00.000Z" },
  });
  expect(await store.read("agent-1", "h1")).toEqual(accepted);
  expect(
    await store.updateDelivery("agent-1", "missing", {
      state: "unknown",
      attemptId: null,
      updatedAt: NOW,
    }),
  ).toBeNull();
});

test("deleting handoffs removes files and the agent directory", async () => {
  const store = new HandoffStore(root);
  await store.create(handoff("h1"));
  await store.create(handoff("h2"));

  await store.delete("agent-1", "h1");
  expect(await store.list("agent-1")).toEqual(["h2"]);
  await store.deleteAgent("agent-1");
  expect(await store.listAgents()).toEqual([]);
});
