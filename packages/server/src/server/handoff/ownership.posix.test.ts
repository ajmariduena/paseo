import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test as platformTest } from "vitest";
import { HandoffOwnership, verifyHandoffRelease } from "./ownership.js";
import { writeJournal } from "./artifacts.js";
import { HandoffDestination } from "./destination.js";
import { HandoffArchiveStore } from "./archive.js";
import { captureWorkspace, packWorkspaceArchive } from "./workspace.js";

const test = platformTest.skipIf(process.platform === "win32");
let root: string;
let cwd: string;
let directory: string;
let ownership: HandoffOwnership;
const sourceServerId = "source-host";
const digest = "a".repeat(64);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-release-"));
  cwd = path.join(root, "workspace");
  directory = path.join(root, "ownership");
  await mkdir(cwd);
  ownership = new HandoffOwnership({ directory, sourceServerId });
  await ownership.initialize();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("reserves stable destination identities across restart without dropping unprepared conversations", async () => {
  const transferId = randomUUID();
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const request = {
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: ["first", "second"],
    destinationParent: root,
  };
  const reserved = await destination.reserve(request);
  expect(reserved.agentMappings.map((mapping) => mapping.sourceAgentId)).toEqual([
    "first",
    "second",
  ]);
  expect(new Set(reserved.agentMappings.map((mapping) => mapping.destinationAgentId)).size).toBe(2);
  const restarted = new HandoffDestination(options);
  await restarted.initialize();
  expect(await restarted.reserve(request)).toEqual(reserved);
  await expect(
    restarted.reserve({ ...request, sourceWorkspaceId: "different" }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(restarted.stage(transferId)).rejects.toMatchObject({
    code: "unprepared_conversations",
  });
});

test("retries archive creation after committing its source binding", async () => {
  const transferId = randomUUID();
  const archivePath = path.join(root, "destination-archives");
  const store = new HandoffArchiveStore(archivePath);
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const reserved = await destination.reserve({
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  });
  const source = await ownership.prepare({
    id: transferId,
    cwd,
    workspaceId: "source-workspace",
    agentIds: [],
    destinationServerId: options.serverId,
    reservationId: reserved.reservationId,
  });
  const artifactDirectory = path.join(root, "snapshot");
  await captureWorkspace({ cwd, artifactDirectory });
  const manifest = await packWorkspaceArchive({
    artifactDirectory,
    transferId,
    store: new HandoffArchiveStore(path.join(root, "source-archives")),
  });
  const binding = { transferId, publicKey: source.publicKey, manifest };
  await writeFile(archivePath, "temporarily unavailable archive directory");
  await expect(destination.bindSource(binding)).rejects.toThrow();
  expect(destination.status(transferId).state).toBe("receiving");
  await rm(archivePath);
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect((await recovered.bindSource(binding)).state).toBe("receiving");
  expect((await store.status(transferId)).state).toBe("receiving");
  await expect(
    recovered.bindSource({
      ...binding,
      manifest: {
        ...manifest,
        entrypoint: { ...manifest.entrypoint, sha256: "a".repeat(64) },
        blobs: [{ ...manifest.entrypoint, sha256: "a".repeat(64) }],
      },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("cancels only private staging and keeps cancellation idempotent after restart", async () => {
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: new HandoffArchiveStore(path.join(root, "archives")),
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const transferId = randomUUID();
  const reserved = await destination.reserve({
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  });
  await mkdir(reserved.stagingCwd);
  await writeFile(path.join(reserved.stagingCwd, "partial"), "incomplete transfer");
  await mkdir(reserved.destinationCwd);
  await writeFile(path.join(reserved.destinationCwd, "user.txt"), "unrelated user file");
  expect((await destination.cancel(transferId)).state).toBe("cancelled");
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect((await recovered.cancel(transferId)).state).toBe("cancelled");
  await expect(readdir(path.dirname(reserved.stagingCwd))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(path.join(reserved.destinationCwd, "user.txt"), "utf8")).toBe(
    "unrelated user file",
  );
  await expect(recovered.stage(transferId)).rejects.toMatchObject({ code: "invalid_state" });
});

test("shutdown waits for an admitted reservation and rejects new work", async () => {
  let holdWrite = false;
  let entered: () => void = () => {};
  let unblock: () => void = () => {};
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: new HandoffArchiveStore(path.join(root, "archives")),
    write: async (file: string, value: unknown) => {
      if (holdWrite) {
        entered();
        await blocked;
      }
      await writeJournal(file, value);
    },
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  holdWrite = true;
  const request = {
    transferId: randomUUID(),
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  };
  const reserving = destination.reserve(request);
  await writing;
  let stopped = false;
  const stopping = destination.dispose().then(() => {
    stopped = true;
    return stopped;
  });
  try {
    await expect(
      destination.reserve({ ...request, transferId: randomUUID() }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(stopped).toBe(false);
  } finally {
    unblock();
  }
  const reserved = await reserving;
  await stopping;
  const recovered = new HandoffDestination({ ...options, write: writeJournal });
  await recovered.initialize();
  expect(await recovered.reserve(request)).toEqual(reserved);
});

test("stages a reserved workspace and accepts only its signed source release", async () => {
  const transferId = randomUUID();
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
  };
  const restarted = new HandoffDestination(options);
  await restarted.initialize();
  const request = {
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  };
  const reserved = await restarted.reserve(request);
  const source = await ownership.prepare({
    id: transferId,
    cwd,
    workspaceId: "source-workspace",
    agentIds: request.sourceAgentIds,
    destinationServerId: options.serverId,
    reservationId: reserved.reservationId,
  });
  await writeFile(path.join(cwd, "work.txt"), "captured work\n");
  const artifactDirectory = path.join(root, "snapshot");
  await captureWorkspace({ cwd, artifactDirectory });
  const manifest = await packWorkspaceArchive({ artifactDirectory, store, transferId });
  await restarted.bindSource({ transferId, publicKey: source.publicKey, manifest });
  const staged = await restarted.stage(transferId);
  expect(staged.state).toBe("staged");
  expect(await readFile(path.join(staged.stagingCwd, "work.txt"), "utf8")).toBe("captured work\n");
  await expect(readFile(path.join(staged.destinationCwd, "work.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await ownership.markReady(transferId, manifest.entrypoint.sha256);
  const binding = {
    version: 1 as const,
    transferId,
    sourceServerId,
    destinationServerId: options.serverId,
    reservationId: reserved.reservationId,
    manifestDigest: manifest.entrypoint.sha256,
  };
  const receipt = await ownership.release(transferId, binding, async () => {});
  await expect(
    restarted.acceptRelease(transferId, { ...receipt, reservationId: randomUUID() }),
  ).rejects.toMatchObject({ code: "invalid_release" });
  const released = await restarted.acceptRelease(transferId, receipt);
  expect(released.state).toBe("released");
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect(await recovered.acceptRelease(transferId, receipt)).toEqual(released);
  await expect(recovered.cancel(transferId)).rejects.toMatchObject({ code: "invalid_state" });
});

async function destinationFixture(write?: typeof writeJournal) {
  const transferId = randomUUID();
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
    write,
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const reservation = await destination.reserve({
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  });
  const source = await ownership.prepare({
    id: transferId,
    cwd,
    workspaceId: "source-workspace",
    agentIds: [],
    destinationServerId: options.serverId,
    reservationId: reservation.reservationId,
  });
  await writeFile(path.join(cwd, "work.txt"), "original\n");
  const artifactDirectory = path.join(root, "snapshot");
  await captureWorkspace({ cwd, artifactDirectory });
  const manifest = await packWorkspaceArchive({ artifactDirectory, store, transferId });
  const bind = { transferId, publicKey: source.publicKey, manifest };
  await destination.bindSource(bind);
  await ownership.markReady(transferId, manifest.entrypoint.sha256);
  const receipt = await ownership.release(
    transferId,
    {
      version: 1,
      transferId,
      sourceServerId,
      destinationServerId: options.serverId,
      reservationId: reservation.reservationId,
      manifestDigest: manifest.entrypoint.sha256,
    },
    async () => {},
  );
  return { destination, options, transferId, reservation, receipt, bind };
}

test("repairs changed private staging from the immutable archive after source release", async () => {
  const { destination, transferId, receipt } = await destinationFixture();
  const staged = await destination.stage(transferId);
  await writeFile(path.join(staged.stagingCwd, "work.txt"), "changed\n");
  await expect(destination.acceptRelease(transferId, receipt)).rejects.toMatchObject({
    code: "source_changed",
  });
  expect(destination.status(transferId).state).toBe("staged");
  await destination.stage(transferId);
  expect(await readFile(path.join(staged.stagingCwd, "work.txt"), "utf8")).toBe("original\n");
  await destination.acceptRelease(transferId, receipt);
  await writeFile(path.join(staged.stagingCwd, "work.txt"), "changed again\n");
  expect((await destination.stage(transferId)).state).toBe("released");
  expect(await readFile(path.join(staged.stagingCwd, "work.txt"), "utf8")).toBe("original\n");
});

test("recovers a destination release committed before its acknowledgement failed", async () => {
  let failAfterWrite = false;
  const write: typeof writeJournal = async (filePath, value) => {
    await writeJournal(filePath, value);
    if (failAfterWrite) throw new Error("lost persistence acknowledgement");
  };
  const { destination, transferId, receipt, options } = await destinationFixture(write);
  const staged = await destination.stage(transferId);
  failAfterWrite = true;
  await expect(destination.acceptRelease(transferId, receipt)).rejects.toThrow(
    "lost persistence acknowledgement",
  );
  expect(() => destination.status(transferId)).toThrow("recovered");
  const recovered = new HandoffDestination({ ...options, write: writeJournal });
  await recovered.initialize();
  expect(await recovered.acceptRelease(transferId, receipt)).toEqual({
    ...staged,
    state: "released",
    receipt,
  });
  await expect(recovered.cancel(transferId)).rejects.toMatchObject({ code: "invalid_state" });
});

test("a dangling mutation path is never treated as an unrelated missing directory", async () => {
  await symlink(path.join(root, "removed-target"), path.join(root, "alias"));
  await expect(
    ownership.withMutation({ cwd: path.join(root, "alias", "nested") }, async () => 1),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

async function prepare() {
  const input = {
    id: randomUUID(),
    cwd,
    workspaceId: "workspace-id",
    agentIds: ["agent-id"],
    destinationServerId: "destination-host",
    reservationId: randomUUID(),
  };
  const status = await ownership.prepare(input);
  await ownership.markReady(input.id, digest);
  return {
    input,
    status,
    binding: {
      version: 1 as const,
      transferId: input.id,
      sourceServerId,
      destinationServerId: input.destinationServerId,
      reservationId: input.reservationId,
      manifestDigest: digest,
    },
  };
}

test("release survives restart, is idempotent and cannot be rolled back by cancellation", async () => {
  const { input, status, binding } = await prepare();
  let validations = 0;
  const receipt = await ownership.release(input.id, binding, async () => {
    validations++;
  });
  expect(verifyHandoffRelease(receipt, binding, status.publicKey)).toBe(true);
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(
    await restarted.release(input.id, binding, async () => {
      validations++;
    }),
  ).toEqual(receipt);
  expect(validations).toBe(1);
  await expect(restarted.cancel(input.id)).rejects.toMatchObject({ code: "invalid_state" });
  await expect(restarted.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
});

test("a lost reply after durable release cannot resurrect source ownership", async () => {
  const { input, binding, status } = await prepare();
  const interrupted = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async (file, value) => {
      await writeJournal(file, value);
      throw new Error("lost after durable write");
    },
  });
  await interrupted.initialize();
  await expect(interrupted.release(input.id, binding, async () => {})).rejects.toThrow(
    "lost after durable write",
  );
  await expect(interrupted.cancel(input.id)).rejects.toMatchObject({ code: "storage_uncertain" });
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(restarted.status(input.id).state).toBe("released");
  const receipt = await restarted.release(input.id, binding, async () => {
    throw new Error("must not revalidate released ownership");
  });
  expect(verifyHandoffRelease(receipt, binding, status.publicKey)).toBe(true);
  await expect(restarted.cancel(input.id)).rejects.toMatchObject({ code: "invalid_state" });
});

test("failure before persisting release returns no receipt and recovers the ready source fence", async () => {
  const { input, binding } = await prepare();
  const failing = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async () => {
      throw new Error("disk full");
    },
  });
  await failing.initialize();
  await expect(failing.release(input.id, binding, async () => {})).rejects.toThrow("disk full");
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(restarted.status(input.id).state).toBe("ready");
  await expect(restarted.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
  expect((await restarted.cancel(input.id)).state).toBe("cancelled");
});

test("cancellation and release serialize so exactly one transition wins", async () => {
  const { input, binding } = await prepare();
  const [cancelled, release] = await Promise.allSettled([
    ownership.cancel(input.id),
    ownership.release(input.id, binding, async () => {}),
  ]);
  expect(cancelled).toMatchObject({ status: "fulfilled", value: { state: "cancelled" } });
  expect(release).toMatchObject({ status: "rejected", reason: { code: "invalid_state" } });
  expect(await ownership.withMutation({ cwd }, async () => 1)).toBe(1);
});

test("a release already verifying cannot be overtaken by cancellation", async () => {
  const { input, binding } = await prepare();
  let releaseVerification: () => void = () => {};
  let entered: () => void = () => {};
  const verifying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unblock = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  const release = ownership.release(input.id, binding, async () => {
    entered();
    await unblock;
  });
  await verifying;
  const cancel = ownership.cancel(input.id);
  const cancelled = expect(cancel).rejects.toMatchObject({ code: "invalid_state" });
  releaseVerification();
  expect(await release).toMatchObject(binding);
  await cancelled;
});

test("failed source verification never produces a receipt and can still be cancelled", async () => {
  const { input, binding } = await prepare();
  await expect(
    ownership.release(input.id, binding, async () => {
      throw new Error("writer did not stop");
    }),
  ).rejects.toThrow("writer did not stop");
  expect(ownership.status(input.id).state).toBe("ready");
  expect((await ownership.cancel(input.id)).state).toBe("cancelled");
});

test("release is bound to the destination, reservation, content and authenticated source key", async () => {
  const { input, binding, status } = await prepare();
  await expect(
    ownership.release(
      input.id,
      { ...binding, destinationServerId: "another-host" },
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  const receipt = await ownership.release(input.id, binding, async () => {});
  expect(
    verifyHandoffRelease(
      receipt,
      { ...binding, destinationServerId: "another-host" },
      status.publicKey,
    ),
  ).toBe(false);
  expect(
    verifyHandoffRelease(receipt, { ...binding, reservationId: randomUUID() }, status.publicKey),
  ).toBe(false);
  expect(
    verifyHandoffRelease(receipt, { ...binding, manifestDigest: "b".repeat(64) }, status.publicKey),
  ).toBe(false);
  expect(
    verifyHandoffRelease(
      { ...receipt, signature: Buffer.alloc(64).toString("base64") },
      binding,
      status.publicKey,
    ),
  ).toBe(false);
  expect(verifyHandoffRelease(receipt, binding, Buffer.alloc(32).toString("base64"))).toBe(false);
  expect(
    verifyHandoffRelease(
      { ...receipt, signature: `${receipt.signature}%%%` },
      binding,
      status.publicKey,
    ),
  ).toBe(false);
});

test("resolves symlink aliases before admitting workspace mutations", async () => {
  await prepare();
  const alias = path.join(root, "alias");
  await symlink(cwd, alias);
  await expect(ownership.withMutation({ cwd: alias }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
});
