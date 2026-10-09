import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { HandoffOwnership } from "./ownership.js";
import { writeJournal } from "./artifacts.js";

let root: string;
let cwd: string;
let directory: string;
let ownership: HandoffOwnership;
const sourceServerId = "source-host";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-ownership-"));
  cwd = path.join(root, "workspace");
  directory = path.join(root, "ownership");
  await mkdir(cwd);
  ownership = new HandoffOwnership({ directory, sourceServerId });
  await ownership.initialize();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function source() {
  return {
    id: randomUUID(),
    cwd,
    workspaceId: "workspace-id",
    agentIds: ["agent-id"],
    destinationServerId: "destination-host",
    reservationId: randomUUID(),
  };
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("restores an existing source fence before allowing any mutation", async () => {
  const input = source();
  const status = await ownership.prepare(input);
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await expect(restarted.withMutation({ cwd }, async () => "unsafe")).rejects.toMatchObject({
    code: "storage_uncertain",
  });
  await restarted.initialize();
  expect(restarted.status(input.id)).toEqual(status);
  await expect(restarted.withMutation({ cwd }, async () => "unsafe")).rejects.toMatchObject({
    code: "fenced",
  });
  expect("privateKey" in status).toBe(false);
});

test("drains mutations already admitted and refuses later mutations before readiness", async () => {
  const entered = deferred();
  const finish = deferred();
  const mutation = ownership.withMutation({ cwd }, async () => {
    entered.resolve();
    await finish.promise;
    return 7;
  });
  await entered.promise;
  const input = source();
  await ownership.prepare(input);
  await expect(ownership.withMutation({ cwd }, async () => "later")).rejects.toMatchObject({
    code: "fenced",
  });
  await expect(ownership.markReady(input.id, "a".repeat(64))).rejects.toMatchObject({
    code: "invalid_state",
  });
  finish.resolve();
  expect(await mutation).toBe(7);
  await ownership.drain(input.id);
  expect((await ownership.markReady(input.id, "a".repeat(64))).state).toBe("ready");
});

test("blocks shared, ancestor and nested checkouts plus moved agent identities", async () => {
  const input = source();
  await mkdir(path.join(cwd, "nested"));
  await mkdir(path.join(root, "sibling"));
  await ownership.prepare(input);
  await expect(
    ownership.withMutation({ cwd, workspaceId: "another-workspace" }, async () => 1),
  ).rejects.toMatchObject({ code: "fenced" });
  await expect(
    ownership.withMutation({ cwd: path.join(cwd, "nested") }, async () => 1),
  ).rejects.toMatchObject({ code: "fenced" });
  await expect(ownership.withMutation({ cwd: root }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
  await expect(
    ownership.withMutation({ cwd: path.join(root, "sibling"), agentId: "agent-id" }, async () => 1),
  ).rejects.toMatchObject({ code: "fenced" });
  expect(await ownership.withMutation({ cwd: path.join(root, "sibling") }, async () => 1)).toBe(1);
});

test("prepare retries are stable and cannot change the reserved destination", async () => {
  const input = source();
  const first = await ownership.prepare(input);
  expect(await ownership.prepare(input)).toEqual(first);
  await expect(
    ownership.prepare({ ...input, destinationServerId: "another-host" }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(ownership.prepare({ ...input, id: randomUUID() })).rejects.toMatchObject({
    code: "fenced",
  });
});

test("cancellation unfreezes only after the cancellation journal is durable", async () => {
  const input = source();
  await ownership.prepare(input);
  const entered = deferred();
  const persist = deferred();
  const controlled = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async (file, value) => {
      entered.resolve();
      await persist.promise;
      await writeJournal(file, value);
    },
  });
  await controlled.initialize();
  const cancel = controlled.cancel(input.id);
  await entered.promise;
  await expect(controlled.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
  persist.resolve();
  expect((await cancel).state).toBe("cancelled");
  expect(await controlled.withMutation({ cwd }, async () => 1)).toBe(1);
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(await restarted.withMutation({ cwd }, async () => 2)).toBe(2);
});

test("a failed cancellation write keeps the source fenced across restart", async () => {
  const input = source();
  await ownership.prepare(input);
  const failing = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async () => {
      throw new Error("disk full");
    },
  });
  await failing.initialize();
  await expect(failing.cancel(input.id)).rejects.toThrow("disk full");
  await expect(failing.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "storage_uncertain",
  });
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  await expect(restarted.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
});

test("a corrupt or missing existing journal fails closed instead of creating an empty one", async () => {
  await ownership.prepare(source());
  const file = path.join(directory, "ownership.json");
  await writeFile(file, "{broken");
  const corrupt = new HandoffOwnership({ directory, sourceServerId });
  await expect(corrupt.initialize()).rejects.toThrow();
  await expect(corrupt.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "storage_uncertain",
  });
  expect(await readFile(file, "utf8")).toBe("{broken");
  await rm(file);
  await expect(
    new HandoffOwnership({ directory, sourceServerId }).initialize(),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("a different host cannot inherit another host's ownership journal", async () => {
  await ownership.prepare(source());
  await expect(
    new HandoffOwnership({ directory, sourceServerId: "different-host" }).initialize(),
  ).rejects.toMatchObject({ code: "storage_uncertain" });
});

test("failure before a first fence write never reports a usable preparation", async () => {
  const input = source();
  const failing = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async () => {
      throw new Error("disk full");
    },
  });
  await failing.initialize();
  await expect(failing.prepare(input)).rejects.toThrow("disk full");
  expect(() => failing.status(input.id)).toThrow("journal is recovered");
  await expect(failing.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "storage_uncertain",
  });
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(() => restarted.status(input.id)).toThrow("record not found");
  expect(await restarted.withMutation({ cwd }, async () => 1)).toBe(1);
});
