import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test as platformTest } from "vitest";
import { HandoffOwnership, verifyHandoffRelease } from "./ownership.js";
import { writeJournal } from "./artifacts.js";

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
