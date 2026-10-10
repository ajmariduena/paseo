import { HANDOFF_CHUNK_BYTES } from "@getpaseo/protocol/handoff";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { HandoffArchiveStore, HANDOFF_ARCHIVE_LIMITS } from "./archive.js";
import { readHandoffHistory, HANDOFF_HISTORY_MAX_BYTES } from "./history.js";
import { readHandoffBundle } from "./bundle.js";

let root: string;
let store: HandoffArchiveStore;
const content = Buffer.from("a resumable workspace artifact\n");
const blob = { sha256: createHash("sha256").update(content).digest("hex"), size: content.length };
const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-archive-"));
  store = new HandoffArchiveStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readNoteBundle(
  version: number,
  notes?: Array<{ id: string; kind: string; label: string }>,
) {
  const conversations = notes
    ? [
        {
          sourceAgentId: "conversation",
          title: null,
          provider: "claude",
          mode: "native",
          session: blob,
          pendingRestartNote: notes,
        },
      ]
    : [];
  const bytes = Buffer.from(
    JSON.stringify({
      version,
      kind: "workspace_handoff",
      sourceServerId: "source",
      sourceWorkspaceId: "workspace",
      sourceCwd: "/source",
      workspace: blob,
      conversations,
    }),
  );
  const entrypoint = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  const entryFile = path.join(root, "bundle.json");
  const payloadFile = path.join(root, "payload");
  await writeFile(entryFile, bytes);
  await writeFile(payloadFile, content);
  const id = randomUUID();
  await store.importLocal({
    id,
    manifest: { version: 1, entrypoint, blobs: [entrypoint, blob] },
    files: new Map([
      [entrypoint.sha256, entryFile],
      [blob.sha256, payloadFile],
    ]),
  });
  return store.withVerifiedArchive(id, (archive) =>
    readHandoffBundle(archive, {
      sourceServerId: "source",
      sourceWorkspaceId: "workspace",
      sourceAgentIds: conversations.map((conversation) => conversation.sourceAgentId),
      manifestDigest: entrypoint.sha256,
    }),
  );
}

test.each([1, 2])("reads a workspace-only archive using bundle version %i", async (version) => {
  expect((await readNoteBundle(version)).bundle.version).toBe(version);
});

test.each([
  { version: 1, count: 1, message: "require handoff bundle version 2" },
  { version: 2, count: 2, message: "Duplicate pending restart note" },
  { version: 2, count: 1025, message: "Invalid workspace and conversation handoff manifest" },
])(
  "rejects unsupported or invalid pending notes: version $version, count $count",
  async ({ version, count, message }) => {
    const notes = Array.from({ length: count }, () => ({
      id: "task",
      kind: "shell",
      label: "Interrupted task",
    }));
    await expect(readNoteBundle(version, notes)).rejects.toThrow(message);
  },
);

test.each([
  { sourceAgentId: "another-agent", seq: 1 },
  { sourceAgentId: "source-agent", seq: 2 },
])(
  "readable history refuses foreign identity or missing rows: $sourceAgentId / $seq",
  async ({ sourceAgentId, seq }) => {
    const file = path.join(root, "history.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sourceAgentId,
        epoch: randomUUID(),
        rows: [
          {
            seq,
            timestamp: new Date().toISOString(),
            item: { type: "user_message", text: "Retained conversation" },
          },
        ],
      }),
    );
    await expect(readHandoffHistory(file, "source-agent")).rejects.toThrow(
      "another conversation or has missing rows",
    );
  },
);

test("readable history refuses an oversized file before reading its content", async () => {
  const file = path.join(root, "history.json");
  await writeFile(file, "");
  await truncate(file, HANDOFF_HISTORY_MAX_BYTES + 1);
  await expect(readHandoffHistory(file, "source-agent")).rejects.toThrow(
    "Invalid handoff metadata file size",
  );
});

test("imports a captured local artifact and resumes an interrupted import without serving partial bytes", async () => {
  const id = randomUUID();
  const localFile = path.join(root, "captured");
  const bytes = Buffer.alloc(HANDOFF_CHUNK_BYTES + 173, 42);
  const localBlob = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  const localManifest = { version: 1 as const, entrypoint: localBlob, blobs: [localBlob] };
  await writeFile(localFile, bytes);
  await store.begin({ id, manifest: localManifest });
  await store.writeChunk({
    id,
    sha256: localBlob.sha256,
    offset: 0,
    data: bytes.subarray(0, 13),
  });
  const restarted = new HandoffArchiveStore(root);
  await restarted.importLocal({
    id,
    manifest: localManifest,
    files: new Map([[localBlob.sha256, localFile]]),
  });
  expect(await restarted.status(id)).toEqual({
    id,
    state: "verified",
    blobs: [{ ...localBlob, receivedBytes: bytes.length }],
  });
  expect(await readFile(path.join(root, id, "blobs", localBlob.sha256))).toEqual(bytes);
  await restarted.importLocal({
    id,
    manifest: localManifest,
    files: new Map([[localBlob.sha256, localFile]]),
  });
  expect(await readFile(localFile)).toEqual(bytes);
});

test("refuses changed local capture bytes and keeps them unavailable until repaired", async () => {
  const id = randomUUID();
  const localFile = path.join(root, "capture");
  await writeFile(localFile, Buffer.alloc(content.length, 42));
  await expect(
    store.importLocal({ id, manifest, files: new Map([[blob.sha256, localFile]]) }),
  ).rejects.toMatchObject({
    code: "integrity_mismatch",
  });
  await expect(store.withVerifiedArchive(id, async () => "restored")).rejects.toMatchObject({
    code: "invalid_state",
  });
  await expect(
    store.readChunk({ id, sha256: blob.sha256, offset: 0, length: content.length }),
  ).rejects.toMatchObject({ code: "invalid_state" });
  await store.resetBlob(id, blob.sha256);
  await writeFile(localFile, content);
  await store.importLocal({ id, manifest, files: new Map([[blob.sha256, localFile]]) });
  expect(
    await store.withVerifiedArchive(id, async ({ blobsDirectory }) =>
      readFile(path.join(blobsDirectory, blob.sha256)),
    ),
  ).toEqual(content);
  await writeFile(path.join(root, id, "blobs", blob.sha256), Buffer.alloc(content.length));
  await expect(store.withVerifiedArchive(id, async () => "restored")).rejects.toMatchObject({
    code: "integrity_mismatch",
  });
});

test("reads verified history metadata with bounded bytes and detects later corruption", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  await expect(store.readVerifiedBlob(id, blob, 1024)).rejects.toMatchObject({
    code: "invalid_state",
  });
  await store.writeChunk({ id, sha256: blob.sha256, offset: 0, data: content });
  await store.seal(id);
  expect(await store.readVerifiedBlob(id, blob, 1024)).toEqual(content);
  await expect(store.readVerifiedBlob(id, blob, 1)).rejects.toMatchObject({
    code: "limit_exceeded",
  });
  await expect(
    store.readVerifiedBlob(id, { ...blob, size: blob.size + 1 }, 1024),
  ).rejects.toMatchObject({ code: "integrity_mismatch" });
  await expect(
    store.readVerifiedBlob(id, { sha256: "f".repeat(64), size: 1 }, 1024),
  ).rejects.toMatchObject({ code: "not_found" });
  await writeFile(path.join(root, id, "blobs", blob.sha256), Buffer.alloc(blob.size));
  await expect(store.readVerifiedBlob(id, blob, 1024)).rejects.toMatchObject({
    code: "integrity_mismatch",
  });
});

test("resumes a partially received artifact after reconstructing the store", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  expect(
    await store.writeChunk({ id, sha256: blob.sha256, offset: 0, data: content.subarray(0, 10) }),
  ).toBe(10);

  const restarted = new HandoffArchiveStore(root);
  expect(await restarted.status(id)).toMatchObject({
    state: "receiving",
    blobs: [{ ...blob, receivedBytes: 10 }],
  });
  await restarted.writeChunk({ id, sha256: blob.sha256, offset: 10, data: content.subarray(10) });
  expect(await restarted.seal(id)).toMatchObject({
    state: "verified",
    blobs: [{ ...blob, receivedBytes: content.length }],
  });
  expect(await readFile(path.join(root, id, "blobs", blob.sha256))).toEqual(content);
});

test("replaying a lost acknowledgement never appends bytes twice", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  const chunk = { id, sha256: blob.sha256, offset: 0, data: content };
  const results = await Promise.all([store.writeChunk(chunk), store.writeChunk(chunk)]);
  expect(results).toEqual([content.length, content.length]);
  await store.seal(id);
  expect(await store.writeChunk(chunk)).toBe(content.length);
  expect(
    await store.readChunk({ id, sha256: blob.sha256, offset: 0, length: HANDOFF_CHUNK_BYTES }),
  ).toEqual(content);
});

test("begin is idempotent but never rebinds an existing transfer ID", async () => {
  const id = randomUUID();
  const first = await store.begin({ id, manifest });
  expect(await store.begin({ id, manifest })).toEqual(first);
  const different = { sha256: "a".repeat(64), size: 10 };
  await expect(
    store.begin({ id, manifest: { version: 1, entrypoint: different, blobs: [different] } }),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("rejects conflicting replays, gaps and partially overlapping chunks without changing received bytes", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  await store.writeChunk({ id, sha256: blob.sha256, offset: 0, data: content.subarray(0, 10) });
  await expect(
    store.writeChunk({ id, sha256: blob.sha256, offset: 0, data: Buffer.alloc(10) }),
  ).rejects.toMatchObject({ code: "chunk_mismatch" });
  await expect(
    store.writeChunk({ id, sha256: blob.sha256, offset: 11, data: content.subarray(11) }),
  ).rejects.toMatchObject({ code: "offset_mismatch" });
  await expect(
    store.writeChunk({ id, sha256: blob.sha256, offset: 5, data: content.subarray(5, 15) }),
  ).rejects.toMatchObject({ code: "offset_mismatch" });
  expect(await readFile(path.join(root, id, "blobs", blob.sha256))).toEqual(
    content.subarray(0, 10),
  );
});

test("refuses incomplete or corrupt blobs and permits an explicit clean retry before verification", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  await expect(store.seal(id)).rejects.toMatchObject({
    code: "integrity_mismatch",
    blob: blob.sha256,
  });
  await store.writeChunk({
    id,
    sha256: blob.sha256,
    offset: 0,
    data: Buffer.alloc(content.length),
  });
  await expect(store.seal(id)).rejects.toMatchObject({
    code: "integrity_mismatch",
    blob: blob.sha256,
  });
  expect((await store.status(id)).state).toBe("receiving");
  await store.resetBlob(id, blob.sha256);
  await store.writeChunk({ id, sha256: blob.sha256, offset: 0, data: content });
  await store.seal(id);
  await expect(store.resetBlob(id, blob.sha256)).rejects.toMatchObject({ code: "invalid_state" });
});

test("rechecks bytes after a previously verified archive is corrupted on disk", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  await store.writeChunk({ id, sha256: blob.sha256, offset: 0, data: content });
  await store.seal(id);
  await writeFile(path.join(root, id, "blobs", blob.sha256), Buffer.alloc(content.length));
  await expect(new HandoffArchiveStore(root).seal(id)).rejects.toMatchObject({
    code: "integrity_mismatch",
  });
});

test("never serves unverified bytes", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  await store.writeChunk({ id, sha256: blob.sha256, offset: 0, data: content });
  await expect(
    store.readChunk({ id, sha256: blob.sha256, offset: 0, length: 10 }),
  ).rejects.toMatchObject({ code: "invalid_state" });
});

test("handles empty artifacts without needing a zero-length network chunk", async () => {
  const id = randomUUID();
  const empty = { sha256: createHash("sha256").digest("hex"), size: 0 };
  await store.begin({ id, manifest: { version: 1, entrypoint: empty, blobs: [empty] } });
  expect(await store.seal(id)).toEqual({
    id,
    state: "verified",
    blobs: [{ ...empty, receivedBytes: 0 }],
  });
  expect(await store.readChunk({ id, sha256: empty.sha256, offset: 0, length: 1 })).toEqual(
    Buffer.alloc(0),
  );
});

test.each(["maxBlobs", "maxBlobBytes", "maxTotalBytes", "maxMetadataBytes"])(
  "enforces receiver %s",
  async (limit) => {
    const constrained = new HandoffArchiveStore(root, { ...HANDOFF_ARCHIVE_LIMITS, [limit]: 0 });
    await expect(constrained.begin({ id: randomUUID(), manifest })).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  },
);

test("rejects duplicate inventory entries and undeclared entrypoints", async () => {
  await expect(
    store.begin({ id: randomUUID(), manifest: { ...manifest, blobs: [blob, blob] } }),
  ).rejects.toMatchObject({ code: "invalid_manifest" });
  await expect(
    store.begin({
      id: randomUUID(),
      manifest: { ...manifest, entrypoint: { ...blob, size: blob.size + 1 } },
    }),
  ).rejects.toMatchObject({ code: "invalid_manifest" });
});

test("rejects undeclared blobs, out-of-bounds writes and oversized chunks", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  await expect(
    store.writeChunk({ id, sha256: "a".repeat(64), offset: 0, data: content }),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    store.writeChunk({ id, sha256: blob.sha256, offset: 1, data: content }),
  ).rejects.toMatchObject({ code: "invalid_chunk" });
  await expect(
    store.writeChunk({
      id,
      sha256: blob.sha256,
      offset: 0,
      data: Buffer.alloc(HANDOFF_CHUNK_BYTES + 1),
    }),
  ).rejects.toMatchObject({ code: "invalid_chunk" });
});

test("a corrupt journal cannot be silently replaced by begin", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  await writeFile(path.join(root, id, "archive.json"), "{broken");
  await expect(new HandoffArchiveStore(root).begin({ id, manifest })).rejects.toMatchObject({
    code: "storage_corrupt",
  });
});

test("copies queued network buffers before the caller can reuse them", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  const data = Buffer.from(content);
  const pending = store.writeChunk({ id, sha256: blob.sha256, offset: 0, data });
  data.fill(0);
  await pending;
  await store.seal(id);
  expect(await readFile(path.join(root, id, "blobs", blob.sha256))).toEqual(content);
});

test("a missing journal cannot reset an existing archive", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  await rm(path.join(root, id, "archive.json"));
  await expect(store.begin({ id, manifest })).rejects.toMatchObject({ code: "storage_corrupt" });
});

test("bounds queued work and accepts requests again after the queue drains", async () => {
  const id = randomUUID();
  await store.begin({ id, manifest });
  const pending = Array.from({ length: 64 }, () => store.status(id));
  await expect(store.status(id)).rejects.toMatchObject({ code: "limit_exceeded" });
  await Promise.all(pending);
  expect(await store.status(id)).toEqual({
    id,
    state: "receiving",
    blobs: [{ ...blob, receivedBytes: 0 }],
  });
});
