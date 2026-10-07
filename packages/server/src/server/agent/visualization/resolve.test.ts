import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  CodexVisualizationStore,
  MAX_VISUALIZATION_BYTES,
  MAX_VISUALIZATION_STATE_BYTES,
  type VisualizationAgent,
} from "./resolve.js";

const homes: string[] = [];
const threadId = "01a114ca-bb8b-7382-ad9d-e82af3dfbca3";

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-visualization-"));
  homes.push(home);
  const cwd = path.join(home, "work");
  const codexHome = path.join(home, "codex-home");
  await mkdir(cwd);
  const agent: VisualizationAgent = {
    id: "agent-a",
    provider: "codex",
    cwd,
    persistence: { sessionId: threadId },
  };
  return { home, cwd, codexHome, agent, store: new CodexVisualizationStore(home, { codexHome }) };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

test("reads only bounded UTF-8 fragments in the agent cwd or its own thread directory", async () => {
  const { home, cwd, codexHome, agent, store } = await fixture();
  const html = `<div>${"x".repeat(3000)}</div>`;
  const file = path.join(cwd, "fruit-comparison.html");
  await writeFile(file, html);
  const read = await store.get(agent, file);
  expect(read).toMatchObject({ canonicalPath: await realpath(file), html, state: null });
  expect(read.revision).toMatch(/^[0-9a-f]{64}$/);

  const ownThread = path.join(codexHome, "visualizations", "2025", "09", "03", threadId);
  await mkdir(ownThread, { recursive: true });
  const threadFile = path.join(ownThread, "thread-view.html");
  await writeFile(threadFile, "<p>Thread</p>");
  expect((await store.get(agent, threadFile)).html).toBe("<p>Thread</p>");

  const other = path.join(home, "other");
  await mkdir(other);
  const otherFile = path.join(other, "other-view.html");
  await writeFile(otherFile, "<p>Other</p>");
  await expect(store.get(agent, otherFile)).rejects.toThrow();
  const otherThread = path.join(
    codexHome,
    "visualizations",
    "2026",
    "10",
    "07",
    "550e8400-e29b-41d4-a716-446655440000",
  );
  await mkdir(otherThread, { recursive: true });
  const otherThreadFile = path.join(otherThread, "other-thread.html");
  await writeFile(otherThreadFile, "<p>Other thread</p>");
  await expect(store.get(agent, otherThreadFile)).rejects.toThrow();
});

test("rejects invalid names, escapes, symlinks, size and malformed UTF-8", async () => {
  const { cwd, agent, store } = await fixture();
  const valid = path.join(cwd, "valid-view.html");
  await writeFile(valid, "<p>Valid</p>");
  for (const requested of [
    "valid-view.html",
    `${cwd}/../work/valid-view.html`,
    path.join(cwd, "Invalid_View.html"),
    path.join(cwd, "bad.txt"),
    `${valid}\n`,
    "file:///work/valid-view.html",
    cwd,
  ]) {
    await expect(store.get(agent, requested)).rejects.toThrow();
  }
  const link = path.join(cwd, "linked-view.html");
  await symlink(valid, link);
  await expect(store.get(agent, link)).rejects.toThrow();
  const realDir = path.join(cwd, "real-dir");
  const linkedDir = path.join(cwd, "linked-dir");
  await mkdir(realDir);
  await writeFile(path.join(realDir, "nested-view.html"), "<p>Nested</p>");
  await symlink(realDir, linkedDir, "dir");
  await expect(store.get(agent, path.join(linkedDir, "nested-view.html"))).rejects.toThrow();
  const oversized = path.join(cwd, "too-large.html");
  await writeFile(oversized, Buffer.alloc(MAX_VISUALIZATION_BYTES + 1));
  await expect(store.get(agent, oversized)).rejects.toThrow();
  const invalid = path.join(cwd, "bad-utf.html");
  await writeFile(invalid, Buffer.from([0xff, 0xfe]));
  await expect(store.get(agent, invalid)).rejects.toThrow();
  await expect(store.get({ ...agent, provider: "claude" }, valid)).rejects.toThrow();
});

test("rejects a file replaced with a symlink after validation", async () => {
  const { home, cwd, agent, codexHome } = await fixture();
  const file = path.join(cwd, "race-view.html");
  const outside = path.join(home, "secret.html");
  await writeFile(file, "<p>Safe</p>");
  await writeFile(outside, "<p>Secret</p>");
  const store = new CodexVisualizationStore(home, {
    codexHome,
    afterResolve: async () => {
      await rename(file, path.join(cwd, "old-view.html"));
      await symlink(outside, file);
    },
  });
  await expect(store.get(agent, file)).rejects.toThrow();
});

test("rejects a symlinked Codex thread directory", async () => {
  const { home, codexHome, agent, store } = await fixture();
  const privateDirectory = path.join(home, "private");
  await mkdir(privateDirectory);
  await writeFile(path.join(privateDirectory, "secret-view.html"), "<p>Secret</p>");
  const datedRoot = path.join(codexHome, "visualizations", "2026", "10", "07");
  await mkdir(datedRoot, { recursive: true });
  await symlink(privateDirectory, path.join(datedRoot, threadId), "dir");
  await expect(
    store.get(agent, path.join(datedRoot, threadId, "secret-view.html")),
  ).rejects.toThrow();
});

test("rejects a symlinked saved cwd root", async () => {
  const { home, cwd, agent, store } = await fixture();
  const linkedCwd = path.join(home, "linked-work");
  await symlink(cwd, linkedCwd, "dir");
  const file = path.join(cwd, "real-view.html");
  await writeFile(file, "<p>Real</p>");
  await expect(
    store.get({ ...agent, cwd: linkedCwd }, path.join(linkedCwd, "real-view.html")),
  ).rejects.toThrow();
});

test("persists isolated 16 KiB state atomically and deletes it with the agent", async () => {
  const { home, cwd, codexHome, agent, store } = await fixture();
  const file = path.join(cwd, "state-view.html");
  await writeFile(file, "<button>Choose</button>");
  const state = { modelContent: { selected: "apple" } };
  expect(await store.setState(agent, file, state)).toEqual({
    modelContent: { selected: "apple" },
    privateContent: null,
  });
  const restarted = new CodexVisualizationStore(home, { codexHome });
  expect((await restarted.get(agent, file)).state).toEqual({
    modelContent: { selected: "apple" },
    privateContent: null,
  });
  expect((await restarted.get({ ...agent, id: "agent-b" }, file)).state).toBeNull();
  const anotherFile = path.join(cwd, "another-view.html");
  await writeFile(anotherFile, "<p>Another</p>");
  expect((await restarted.get(agent, anotherFile)).state).toBeNull();
  await expect(
    store.setState(agent, file, { modelContent: "x".repeat(MAX_VISUALIZATION_STATE_BYTES) }),
  ).rejects.toThrow();
  await expect(store.setState(agent, file, { image: "data:image/png;base64,a" })).rejects.toThrow();
  await store.deleteAgent(agent.id);
  expect((await restarted.get(agent, file)).state).toBeNull();
  const stateRoot = path.join(home, "visualization-state", agent.id);
  await expect(stat(stateRoot)).rejects.toThrow();
});
