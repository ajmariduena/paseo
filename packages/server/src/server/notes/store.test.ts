import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { NoteStore } from "./store.js";

function createClock(start: string): { now: () => Date; advance: (ms: number) => void } {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("NoteStore", () => {
  let tempDir: string;
  let clock: ReturnType<typeof createClock>;
  let store: NoteStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "note-store-test-"));
    clock = createClock("2026-01-01T00:00:00.000Z");
    store = new NoteStore(tempDir, createTestLogger(), clock.now);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates a plain note and reloads it from disk", async () => {
    const created = await store.create({
      title: "  Idea  ",
      body: "Some **markdown**",
      projectId: "project-1",
      workspaceId: "workspace-1",
      author: { type: "user" },
    });

    expect(created).toMatchObject({
      title: "Idea",
      body: "Some **markdown**",
      todoState: null,
      projectId: "project-1",
      workspaceId: "workspace-1",
      author: { type: "user" },
      linkedAgents: [],
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 0,
    });

    const reloaded = new NoteStore(tempDir, createTestLogger());
    expect(await reloaded.list()).toEqual([created]);
  });

  test("creates a todo in the open state", async () => {
    const created = await store.create({
      title: "Fix the flaky test",
      todo: true,
      author: { type: "agent", agentId: "agent-1" },
    });

    expect(created.todoState).toBe("open");
    expect(created.body).toBe("");
    expect(created.projectId).toBeNull();
    expect(created.author).toEqual({ type: "agent", agentId: "agent-1" });
  });

  test("rejects a note with an empty title and body", async () => {
    await expect(
      store.create({ title: "  ", body: "\n", author: { type: "user" } }),
    ).rejects.toMatchObject({ code: "note_invalid" });
    expect(await readdir(tempDir).catch(() => [])).toEqual([]);
  });

  test("accepts a note with only a body", async () => {
    const created = await store.create({ title: "", body: "Body only", author: { type: "user" } });
    expect(created.title).toBe("");
  });

  test("update bumps the revision and updatedAt", async () => {
    const created = await store.create({ title: "Draft", author: { type: "user" } });
    clock.advance(1000);

    const updated = await store.update(created.id, { body: "More detail", todoState: "done" });

    expect(updated).toMatchObject({
      title: "Draft",
      body: "More detail",
      todoState: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      revision: 1,
    });
    expect(await store.get(created.id)).toEqual(updated);
  });

  test("update rejects clearing both title and body", async () => {
    const created = await store.create({ title: "Draft", author: { type: "user" } });
    await expect(store.update(created.id, { title: " " })).rejects.toMatchObject({
      code: "note_invalid",
    });
    expect(await store.get(created.id)).toEqual(created);
  });

  test("update with a stale expectedRevision fails with note_revision_conflict", async () => {
    const created = await store.create({ title: "Draft", author: { type: "user" } });
    await store.update(created.id, { title: "Edited elsewhere", expectedRevision: 0 });

    await expect(
      store.update(created.id, { title: "Stale edit", expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "note_revision_conflict" });
    expect((await store.require(created.id)).title).toBe("Edited elsewhere");
  });

  test("setArchived hides the note from list unless includeArchived, and is idempotent", async () => {
    const created = await store.create({ title: "Old", author: { type: "user" } });
    clock.advance(1000);

    const archived = await store.setArchived(created.id, true);
    expect(archived.archivedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(archived.revision).toBe(1);
    expect(await store.list()).toEqual([]);
    expect(await store.list({ includeArchived: true })).toEqual([archived]);

    clock.advance(1000);
    expect(await store.setArchived(created.id, true)).toEqual(archived);

    const restored = await store.setArchived(created.id, false);
    expect(restored.archivedAt).toBeNull();
    expect(restored.revision).toBe(2);
    expect(await store.list()).toEqual([restored]);
  });

  test("linkAgent records each agent once", async () => {
    const created = await store.create({ title: "Hand off", author: { type: "user" } });

    const linked = await store.linkAgent(created.id, "agent-1");
    const again = await store.linkAgent(created.id, "agent-1");

    expect(linked.linkedAgents).toEqual([
      { agentId: "agent-1", linkedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(again).toEqual(linked);
  });

  test("delete removes the file and a missing id fails with note_not_found", async () => {
    const created = await store.create({ title: "Gone", author: { type: "user" } });

    await store.delete(created.id);

    expect(await store.get(created.id)).toBeNull();
    expect(await readdir(tempDir)).toEqual([]);
    await expect(store.delete(created.id)).rejects.toMatchObject({ code: "note_not_found" });
    await expect(store.update("missing", { title: "x" })).rejects.toMatchObject({
      code: "note_not_found",
    });
  });

  test("list skips invalid JSON files", async () => {
    const created = await store.create({ title: "Valid", author: { type: "user" } });
    await writeFile(join(tempDir, "broken.json"), "{not json", "utf-8");
    await writeFile(join(tempDir, "wrong-shape.json"), JSON.stringify({ id: "x" }), "utf-8");

    expect(await store.list()).toEqual([created]);
  });

  test("list returns the most recently updated note first", async () => {
    const first = await store.create({ title: "First", author: { type: "user" } });
    clock.advance(1000);
    const second = await store.create({ title: "Second", author: { type: "user" } });
    clock.advance(1000);
    const touched = await store.update(first.id, { body: "touched" });

    expect((await store.list()).map((note) => note.id)).toEqual([touched.id, second.id]);
  });
});
