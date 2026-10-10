import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  AgentQueueStore,
  QueueEntryTooLargeError,
  type AgentQueueEntry,
  type NewQueueEntry,
} from "./store.js";

const NOW = "2026-10-04T00:00:00.000Z";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-agent-queue-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function userMessage(id: string, prompt: NewQueueEntry["prompt"] = `text of ${id}`): NewQueueEntry {
  return { id, origin: "user", senderAgentId: null, textPreview: "", prompt, wake: null };
}

function wake(id: string, generation: number): NewQueueEntry {
  return {
    id,
    origin: "delegation_wake",
    senderAgentId: null,
    textPreview: "Review finished",
    prompt: null,
    wake: { cohortKey: "run-1", generation },
  };
}

function readQueueFile(agentId: string): unknown {
  return JSON.parse(readFileSync(join(root, `${agentId}.json`), "utf8"));
}

async function drainIds(store: AgentQueueStore, agentId: string): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const next = await store.dequeueNext(agentId);
    if (!next) return ids;
    ids.push(next.entry.id);
  }
}

test("enqueue writes one queue file per agent with positions, and the prompt in a sidecar", async () => {
  const store = new AgentQueueStore(root);
  const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  const second = await store.enqueue(
    "agent-1",
    userMessage("m2", [{ type: "text", text: "look at this" }, image]),
    NOW,
  );

  const expectedSecond: AgentQueueEntry = {
    id: "m2",
    origin: "user",
    senderAgentId: null,
    position: 2,
    createdAt: NOW,
    textPreview: "look at this",
    attachmentCount: 1,
    promptFile: second.promptFile,
    wake: null,
  };
  expect(second).toEqual(expectedSecond);
  expect(readQueueFile("agent-1")).toEqual({
    version: 1,
    agentId: "agent-1",
    held: false,
    heldReason: null,
    entries: [
      {
        id: "m1",
        origin: "user",
        senderAgentId: null,
        position: 1,
        createdAt: NOW,
        textPreview: "text of m1",
        attachmentCount: 0,
        promptFile: expect.any(String),
        wake: null,
      },
      expectedSecond,
    ],
  });
  expect(readFileSync(join(root, "agent-1.json"), "utf8")).not.toContain(image.data);

  const first = await store.dequeueNext("agent-1");
  expect(first?.prompt).toBe("text of m1");
  const next = await store.dequeueNext("agent-1");
  expect(next?.prompt).toEqual([{ type: "text", text: "look at this" }, image]);
});

test("delegation wakes are delivered before user messages, then by position", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  await store.enqueue("agent-1", wake("wake-1", 1), NOW);
  await store.enqueue("agent-1", userMessage("m2"), NOW);
  await store.enqueue("agent-1", wake("wake-2", 2), NOW);

  expect(await drainIds(store, "agent-1")).toEqual(["wake-1", "wake-2", "m1", "m2"]);
});

test("a held queue delivers nothing, keeps later entries held, and stops holding once empty", async () => {
  const store = new AgentQueueStore(root);
  expect(await store.hold("agent-1", "user_stop")).toBe(false);

  await store.enqueue("agent-1", userMessage("m1"), NOW);
  expect(await store.hold("agent-1", "failure")).toBe(true);
  await store.enqueue("agent-1", wake("wake-1", 1), NOW);

  expect(await store.dequeueNext("agent-1")).toBeNull();
  expect(store.peek("agent-1")).toMatchObject({ held: true, heldReason: "failure" });

  await store.take("agent-1", "m1");
  await store.take("agent-1", "wake-1");
  expect(store.peek("agent-1")).toBeNull();
  await store.enqueue("agent-1", userMessage("m2"), NOW);
  expect(store.peek("agent-1")).toMatchObject({ held: false, heldReason: null });

  await store.hold("agent-1", "user_stop");
  expect(await store.resume("agent-1")).toBe(true);
  expect(await drainIds(store, "agent-1")).toEqual(["m2"]);
});

test("reorder moves the listed entries to the front and rejects unknown ids", async () => {
  const store = new AgentQueueStore(root);
  for (const id of ["m1", "m2", "m3", "m4"]) {
    await store.enqueue("agent-1", userMessage(id), NOW);
  }

  expect(await store.reorder("agent-1", ["m3", "missing"])).toBe(false);
  expect(await store.reorder("agent-1", ["m4", "m2"])).toBe(true);

  expect(await drainIds(store, "agent-1")).toEqual(["m4", "m2", "m1", "m3"]);
});

test("edit replaces the text, keeps images, and deletes the old prompt", async () => {
  const store = new AgentQueueStore(root);
  const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
  const original = await store.enqueue(
    "agent-1",
    userMessage("m1", [{ type: "text", text: "first" }, image]),
    NOW,
  );

  const edited = await store.edit("agent-1", "m1", "second");

  expect(edited).toMatchObject({ id: "m1", textPreview: "second", attachmentCount: 1 });
  expect(readdirSync(join(root, "agent-1"))).toEqual([edited?.promptFile]);
  expect(edited?.promptFile).not.toBe(original.promptFile);
  expect((await store.dequeueNext("agent-1"))?.prompt).toEqual([
    { type: "text", text: "second" },
    image,
  ]);
  expect(await store.edit("agent-1", "m1", "gone")).toBeNull();
});

test("load restores queues from disk and removes prompts nothing references", async () => {
  const writer = new AgentQueueStore(root);
  await writer.enqueue("agent-1", userMessage("m1"), NOW);
  await writer.hold("agent-1", "restart");
  writeFileSync(join(root, "agent-1", "orphan.json"), JSON.stringify("lost"));

  const reader = new AgentQueueStore(root);
  await reader.load();

  expect(reader.agentIds()).toEqual(["agent-1"]);
  expect(reader.peek("agent-1")).toMatchObject({ held: true, heldReason: "restart" });
  expect(readdirSync(join(root, "agent-1"))).toHaveLength(1);
  await reader.resume("agent-1");
  expect((await reader.dequeueNext("agent-1"))?.prompt).toBe("text of m1");
});

test("a prompt over the size cap is rejected before anything is written", async () => {
  const store = new AgentQueueStore(root);
  const huge = "x".repeat(33 * 1024 * 1024);

  await expect(store.enqueue("agent-1", userMessage("m1", huge), NOW)).rejects.toBeInstanceOf(
    QueueEntryTooLargeError,
  );
  expect(readdirSync(root)).toEqual([]);
});

test("a restart drops process-bound system entries and holds the rest", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  await store.enqueue(
    "agent-1",
    { ...wake("perm:child:req-1", 0), origin: "system", wake: null },
    NOW,
  );
  await store.enqueue("agent-1", wake("wake-1", 1), NOW);
  await store.enqueue(
    "agent-2",
    { ...wake("perm:child:req-2", 0), origin: "system", wake: null },
    NOW,
  );

  expect((await store.holdForRestart("agent-1")).map((entry) => entry.id)).toEqual([
    "perm:child:req-1",
  ]);
  await store.holdForRestart("agent-2");

  expect(store.peek("agent-1")).toMatchObject({
    held: true,
    heldReason: "restart",
    entries: [{ id: "m1" }, { id: "wake-1" }],
  });
  expect(store.peek("agent-2")).toBeNull();
});

test("a claim keeps the entry and its prompt until the submission outcome settles", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  await store.enqueue("agent-1", userMessage("m2"), NOW);

  const claimed = await store.claimNext("agent-1", "attempt-1", NOW);
  expect(claimed?.entry.id).toBe("m1");
  expect(claimed?.prompt).toBe("text of m1");
  expect(store.claims("agent-1")).toEqual([
    { entry: claimed?.entry, attemptId: "attempt-1", claimedAt: NOW, outcome: null },
  ]);
  expect(store.peek("agent-1")?.entries.map((entry) => entry.id)).toEqual(["m2"]);
  expect(readdirSync(join(root, "agent-1"))).toHaveLength(2);

  // A restart reads the claim back; the sidecar is still referenced and survives the sweep.
  const reloaded = new AgentQueueStore(root);
  await reloaded.load();
  expect(reloaded.claims("agent-1").map((claim) => claim.entry.id)).toEqual(["m1"]);
  expect(readdirSync(join(root, "agent-1"))).toHaveLength(2);

  await reloaded.settleClaim("agent-1", "attempt-1", "accepted");
  expect(reloaded.claims("agent-1")).toEqual([]);
  expect(readdirSync(join(root, "agent-1"))).toHaveLength(1);
});

test("an unsent outcome restores the entry with its payload and holds the queue", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  const claimed = await store.claimNext("agent-1", "attempt-1", NOW);

  await store.settleClaim("agent-1", "attempt-1", "unsent");

  expect(store.claims("agent-1")).toEqual([]);
  expect(store.peek("agent-1")).toMatchObject({ held: true, heldReason: "failure" });
  expect(await store.dequeueNext("agent-1")).toBeNull();
  await store.resume("agent-1");
  const back = await store.dequeueNext("agent-1");
  expect(back?.entry).toEqual(claimed?.entry);
  expect(back?.prompt).toBe("text of m1");
});

test("an unknown outcome keeps the claim so nothing replays it on its own", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  await store.claimNext("agent-1", "attempt-1", NOW);

  await store.settleClaim("agent-1", "attempt-1", "unknown");

  expect(store.claims("agent-1")).toMatchObject([{ attemptId: "attempt-1", outcome: "unknown" }]);
  expect(await store.dequeueNext("agent-1")).toBeNull();
  expect(readQueueFile("agent-1")).toMatchObject({
    entries: [],
    claims: [{ attemptId: "attempt-1" }],
  });
  expect(await store.settleClaim("agent-1", "missing", "accepted")).toBeNull();
});

test("queue files written before claims existed still load", async () => {
  writeFileSync(
    join(root, "agent-1.json"),
    JSON.stringify({ version: 1, agentId: "agent-1", held: false, heldReason: null, entries: [] }),
  );
  const store = new AgentQueueStore(root);
  await store.load();
  expect(store.claims("agent-1")).toEqual([]);
});

test("retrying a claim returns the same claim and an unknown claim keeps its message id owned", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("a"), NOW);
  await store.enqueue("agent-1", userMessage("b"), NOW);

  const first = await store.claimNext("agent-1", "attempt-1", NOW);
  const retried = await store.claimNext("agent-1", "attempt-1", NOW);
  expect(retried?.entry).toEqual(first?.entry);
  expect(store.claims("agent-1").map((claim) => claim.entry.id)).toEqual(["a"]);
  expect(store.peek("agent-1")?.entries.map((entry) => entry.id)).toEqual(["b"]);

  await store.settleClaim("agent-1", "attempt-1", "unknown");
  const reloaded = new AgentQueueStore(root);
  await reloaded.load();
  const again = await reloaded.enqueue("agent-1", userMessage("a"), NOW);
  expect(again).toEqual(first?.entry);
  expect(reloaded.peek("agent-1")?.entries.map((entry) => entry.id)).toEqual(["b"]);
  expect(await reloaded.claimNext("agent-1", "attempt-1", NOW)).toMatchObject({
    entry: { id: "a" },
  });
  expect((await reloaded.claimNext("agent-1", "attempt-2", NOW))?.entry.id).toBe("b");
  expect(reloaded.claims("agent-1").map((claim) => claim.attemptId)).toEqual([
    "attempt-1",
    "attempt-2",
  ]);
});
