import {
  transferHandoffArchive,
  type HandoffTransferProgress,
  DaemonClient as TransportClient,
} from "@getpaseo/client/internal/daemon-client";
import { WebSocket, type RawData } from "ws";
import { WSOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { HANDOFF_CHUNK_BYTES } from "@getpaseo/protocol/handoff";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

interface Host {
  daemon: TestPaseoDaemon;
  client: DaemonClient;
}
let root: string;
const running = new Set<Host>();

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-network-"));
});
afterEach(async () => {
  for (const host of running) await stopHost(host);
  await rm(root, { recursive: true, force: true });
}, 30_000);

async function startHost(name: string): Promise<Host> {
  const home = path.join(root, name);
  const staticDir = path.join(home, "static");
  await mkdir(staticDir, { recursive: true });
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: home,
    staticDir,
    cleanup: false,
    mcpEnabled: false,
    agentClients: {},
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.1",
  });
  const host = { daemon, client };
  running.add(host);
  await client.connect();
  return host;
}

async function stopHost(host: Host): Promise<void> {
  running.delete(host);
  await host.client.close();
  await host.daemon.close();
}

test("streams bounded chunks between two real daemons and resumes after destination restart", async () => {
  const source = await startHost("source");
  let destination = await startHost("destination");
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES * 2 + 173);
  for (let index = 0; index < data.length; index++) data[index] = index % 251;
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  const transferId = randomUUID();
  expect((await source.client.handoffArchiveBegin({ transferId, manifest })).error).toBeNull();
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + HANDOFF_CHUNK_BYTES);
    expect(
      (
        await source.client.handoffArchiveWriteChunk({
          transferId,
          sha256: blob.sha256,
          offset,
          data: chunk.toString("base64"),
        })
      ).result,
    ).toBe(offset + chunk.length);
  }
  expect((await source.client.handoffArchiveSeal({ transferId })).result?.state).toBe("verified");
  expect((await destination.client.handoffArchiveBegin({ transferId, manifest })).error).toBeNull();
  const first = await source.client.handoffArchiveReadChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    length: HANDOFF_CHUNK_BYTES,
  });
  if (first.result === null) throw new Error("Source returned no chunk");
  expect(
    (
      await destination.client.handoffArchiveWriteChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        data: first.result,
      })
    ).result,
  ).toBe(HANDOFF_CHUNK_BYTES);

  await stopHost(destination);
  destination = await startHost("destination");
  expect((await destination.client.handoffArchiveStatus({ transferId })).result).toEqual({
    id: transferId,
    state: "receiving",
    blobs: [{ ...blob, receivedBytes: HANDOFF_CHUNK_BYTES }],
  });
  // A client that lost the acknowledgement can replay it without duplicating bytes.
  expect(
    (
      await destination.client.handoffArchiveWriteChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        data: first.result,
      })
    ).result,
  ).toBe(HANDOFF_CHUNK_BYTES);
  const progress: HandoffTransferProgress[] = [];
  expect(
    await transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest,
      onProgress: (value) => progress.push(value),
    }),
  ).toEqual({
    id: transferId,
    state: "verified",
    blobs: [{ ...blob, receivedBytes: blob.size }],
  });
  expect(progress).toEqual([
    { phase: "transferring", receivedBytes: HANDOFF_CHUNK_BYTES, totalBytes: blob.size },
    { phase: "transferring", receivedBytes: HANDOFF_CHUNK_BYTES * 2, totalBytes: blob.size },
    { phase: "transferring", receivedBytes: blob.size, totalBytes: blob.size },
    { phase: "verifying", receivedBytes: blob.size, totalBytes: blob.size },
    { phase: "verified", receivedBytes: blob.size, totalBytes: blob.size },
  ]);
  expect(
    await readFile(
      path.join(
        destination.daemon.paseoHome,
        "handoff",
        "archives",
        transferId,
        "blobs",
        blob.sha256,
      ),
    ),
  ).toEqual(data);
  expect((await destination.client.fetchAgents()).entries).toEqual([]);
}, 30_000);

test("returns correlated integrity and encoding failures and repairs an unverified blob", async () => {
  const { client } = await startHost("receiver");
  const transferId = randomUUID();
  const data = Buffer.from("preserve every byte");
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  await client.handoffArchiveBegin({
    transferId,
    manifest: { version: 1, entrypoint: blob, blobs: [blob] },
  });
  expect(
    await client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset: 0,
      data: "%%%",
      requestId: "bad-encoding",
    }),
  ).toEqual({
    requestId: "bad-encoding",
    transferId,
    result: null,
    error: {
      code: "invalid_chunk",
      message: "Chunk must use canonical base64 encoding",
      blob: null,
    },
  });
  await client.handoffArchiveWriteChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    data: Buffer.alloc(data.length).toString("base64"),
  });
  expect((await client.handoffArchiveSeal({ transferId })).error).toMatchObject({
    code: "integrity_mismatch",
    blob: blob.sha256,
  });
  expect(
    (
      await client.handoffArchiveReadChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        length: 10,
      })
    ).error,
  ).toMatchObject({ code: "invalid_state" });
  expect((await client.handoffArchiveResetBlob({ transferId, sha256: blob.sha256 })).result).toBe(
    true,
  );
  await client.handoffArchiveWriteChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    data: data.toString("base64"),
  });
  expect((await client.handoffArchiveSeal({ transferId })).result?.state).toBe("verified");
}, 30_000);

test("a socket lost after a committed write resumes from disk without duplicating the chunk", async () => {
  const source = await startHost("source");
  const destination = await startHost("destination");
  const transferId = randomUUID();
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES + 83, 137);
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  await source.client.handoffArchiveBegin({ transferId, manifest });
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    await source.client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset,
      data: data.subarray(offset, offset + HANDOFF_CHUNK_BYTES).toString("base64"),
    });
  }
  await source.client.handoffArchiveSeal({ transferId });
  let droppedReplies = 0;
  const interrupted = new TransportClient({
    clientId: "handoff-lost-reply",
    url: `ws://127.0.0.1:${destination.daemon.port}/ws`,
    reconnect: { enabled: false },
    transportFactory: ({ url, headers, protocols }) => {
      const socket = new WebSocket(url, protocols, { headers });
      return {
        send: (value) => socket.send(value),
        close: (code, reason) => socket.close(code, reason),
        onOpen: (handler) => {
          socket.on("open", handler);
          return () => {
            socket.off("open", handler);
          };
        },
        onClose: (handler) => {
          socket.on("close", handler);
          return () => {
            socket.off("close", handler);
          };
        },
        onError: (handler) => {
          socket.on("error", handler);
          return () => {
            socket.off("error", handler);
          };
        },
        onMessage: (handler) => {
          const receive = (bytes: RawData, binary: boolean) => {
            const message = binary
              ? null
              : WSOutboundMessageSchema.parse(JSON.parse(bytes.toString()));
            if (
              message?.type === "session" &&
              message.message.type === "workspace.handoff.write_archive_chunk.response"
            ) {
              droppedReplies++;
              socket.terminate();
              return;
            }
            handler(bytes, binary);
          };
          socket.on("message", receive);
          return () => {
            socket.off("message", receive);
          };
        },
      };
    },
  });
  try {
    await interrupted.connect();
    await expect(
      transferHandoffArchive({
        source: source.client,
        destination: interrupted,
        transferId,
        manifest,
      }),
    ).rejects.toMatchObject({ name: "DaemonConnectionError" });
    expect(droppedReplies).toBe(1);
    expect((await destination.client.handoffArchiveStatus({ transferId })).result?.blobs).toEqual([
      { ...blob, receivedBytes: HANDOFF_CHUNK_BYTES },
    ]);
    expect(
      (
        await transferHandoffArchive({
          source: source.client,
          destination: destination.client,
          transferId,
          manifest,
        })
      ).state,
    ).toBe("verified");
    expect(
      await readFile(
        path.join(
          destination.daemon.paseoHome,
          "handoff",
          "archives",
          transferId,
          "blobs",
          blob.sha256,
        ),
      ),
    ).toEqual(data);
  } finally {
    await interrupted.close();
  }
}, 30_000);

test("pausing between chunks keeps verified source data and resumes only missing bytes", async () => {
  const source = await startHost("source");
  const destination = await startHost("destination");
  const transferId = randomUUID();
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES + 57, 42);
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  await source.client.handoffArchiveBegin({ transferId, manifest });
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    await source.client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset,
      data: data.subarray(offset, offset + HANDOFF_CHUNK_BYTES).toString("base64"),
    });
  }
  await source.client.handoffArchiveSeal({ transferId });
  const pause = new AbortController();
  await expect(
    transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest,
      signal: pause.signal,
      onProgress: (progress) => {
        if (progress.receivedBytes === HANDOFF_CHUNK_BYTES)
          pause.abort(new Error("User paused the transfer"));
      },
    }),
  ).rejects.toThrow("User paused the transfer");
  expect((await destination.client.handoffArchiveStatus({ transferId })).result).toEqual({
    id: transferId,
    state: "receiving",
    blobs: [{ ...blob, receivedBytes: HANDOFF_CHUNK_BYTES }],
  });
  expect((await source.client.handoffArchiveStatus({ transferId })).result?.state).toBe("verified");
  expect(
    (
      await transferHandoffArchive({
        source: source.client,
        destination: destination.client,
        transferId,
        manifest,
      })
    ).state,
  ).toBe("verified");
}, 30_000);
