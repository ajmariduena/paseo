import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readBoundedFile, syncDirectory, writeJournal } from "./artifacts.js";
import {
  HANDOFF_CHUNK_BYTES,
  HandoffTransferIdSchema as TransferIdSchema,
  HandoffArchiveManifestSchema as ArchiveManifestSchema,
  type HandoffBlob,
  type HandoffArchiveManifest,
  type HandoffArchiveStatus,
} from "@getpaseo/protocol/handoff";

const RecordSchema = z.object({
  version: z.literal(1),
  id: TransferIdSchema,
  manifest: ArchiveManifestSchema,
  state: z.enum(["receiving", "verified"]),
});
type ArchiveRecord = z.infer<typeof RecordSchema>;

export interface ArchiveLimits {
  maxBlobs: number;
  maxBlobBytes: number;
  maxTotalBytes: number;
  maxMetadataBytes: number;
}
export const HANDOFF_ARCHIVE_LIMITS: ArchiveLimits = {
  maxBlobs: 100_010,
  maxBlobBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxMetadataBytes: 20 * 1024 * 1024,
};

type ArchiveErrorCode =
  | "invalid_manifest"
  | "invalid_chunk"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "offset_mismatch"
  | "chunk_mismatch"
  | "integrity_mismatch"
  | "limit_exceeded"
  | "storage_corrupt";
export class HandoffArchiveError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
    readonly blob: string | null = null,
  ) {
    super(message);
    this.name = "HandoffArchiveError";
  }
}

interface BeginInput {
  id: string;
  manifest: HandoffArchiveManifest;
}
interface LocalArchiveInput extends BeginInput {
  files: ReadonlyMap<string, string>;
}
interface ChunkInput {
  id: string;
  sha256: string;
  offset: number;
  data: Buffer;
}
interface ReadInput {
  id: string;
  sha256: string;
  offset: number;
  length: number;
}
type BlobProgress = HandoffArchiveStatus["blobs"][number];

function fail(code: ArchiveErrorCode, message: string, blob: string | null = null): never {
  throw new HandoffArchiveError(code, message, blob);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function canonicalManifest(
  value: HandoffArchiveManifest,
  limits: ArchiveLimits,
): HandoffArchiveManifest {
  const parsed = ArchiveManifestSchema.safeParse(value);
  if (!parsed.success) fail("invalid_manifest", "Invalid handoff archive manifest");
  const manifest = parsed.data;
  if (manifest.blobs.length > limits.maxBlobs) fail("limit_exceeded", "Too many handoff blobs");
  let total = 0;
  const hashes = new Set<string>();
  let foundEntrypoint = false;
  for (const blob of manifest.blobs) {
    if (hashes.has(blob.sha256)) fail("invalid_manifest", "Duplicate handoff blob");
    hashes.add(blob.sha256);
    total += blob.size;
    if (blob.size > limits.maxBlobBytes || total > limits.maxTotalBytes)
      fail("limit_exceeded", "Handoff archive exceeds the byte limit");
    if (blob.sha256 === manifest.entrypoint.sha256 && blob.size === manifest.entrypoint.size)
      foundEntrypoint = true;
  }
  if (!foundEntrypoint) fail("invalid_manifest", "Archive entrypoint is not in its blob inventory");
  manifest.blobs.sort((left, right) => left.sha256.localeCompare(right.sha256));
  if (Buffer.byteLength(JSON.stringify(manifest)) > limits.maxMetadataBytes)
    fail("limit_exceeded", "Archive manifest is too large");
  return manifest;
}

/** One instance per daemon; all requests for an archive share its mutation queue. */
export class HandoffArchiveStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private pendingOperations = 0;
  private pendingBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly limits: ArchiveLimits = HANDOFF_ARCHIVE_LIMITS,
  ) {}

  async begin(input: BeginInput): Promise<HandoffArchiveStatus> {
    TransferIdSchema.parse(input.id);
    const manifest = canonicalManifest(input.manifest, this.limits);
    return this.serialize(
      input.id,
      async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const existing = await this.readRecordOrNull(input.id);
        if (existing) {
          if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest))
            fail("conflict", "This handoff ID already belongs to another archive");
          return this.progress(existing);
        }
        const temporary = await mkdtemp(path.join(this.directory, ".begin-"));
        try {
          await mkdir(path.join(temporary, "blobs"), { mode: 0o700 });
          const record: ArchiveRecord = { version: 1, id: input.id, manifest, state: "receiving" };
          await writeJournal(path.join(temporary, "archive.json"), record);
          await rename(temporary, this.location(input.id));
          await syncDirectory(this.directory);
          return this.progress(record);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
      Buffer.byteLength(JSON.stringify(manifest)),
    );
  }

  async status(id: string): Promise<HandoffArchiveStatus> {
    return this.serialize(id, async () => this.progress(await this.readRecord(id)));
  }

  /** Server-owned capture files; this operation is deliberately absent from the wire API. */
  async importLocal(input: LocalArchiveInput): Promise<HandoffArchiveStatus> {
    const manifest = canonicalManifest(input.manifest, this.limits);
    const files = new Map(input.files);
    if (
      files.size !== manifest.blobs.length ||
      manifest.blobs.some((blob) => !files.has(blob.sha256))
    )
      fail("invalid_manifest", "Local files do not match the archive inventory");
    const status = await this.begin({ id: input.id, manifest });
    const received = new Map(status.blobs.map((blob) => [blob.sha256, blob.receivedBytes]));
    for (const blob of manifest.blobs) {
      const file = await open(files.get(blob.sha256)!, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== blob.size)
          fail("integrity_mismatch", "Captured file differs from its inventory", blob.sha256);
        let offset = 0;
        for await (const data of file.createReadStream({
          autoClose: false,
          highWaterMark: HANDOFF_CHUNK_BYTES,
        })) {
          if (offset + data.length > blob.size)
            fail("integrity_mismatch", "Captured file grew during import", blob.sha256);
          // Replaying the prefix validates an earlier attempt instead of trusting its offset.
          // A crash may leave a partial chunk. Separate its replay from the new suffix.
          const split = (received.get(blob.sha256) ?? 0) - offset;
          if (split > 0 && split < data.length) {
            await this.writeChunk({
              id: input.id,
              sha256: blob.sha256,
              offset,
              data: data.subarray(0, split),
            });
            await this.writeChunk({
              id: input.id,
              sha256: blob.sha256,
              offset: offset + split,
              data: data.subarray(split),
            });
          } else {
            await this.writeChunk({ id: input.id, sha256: blob.sha256, offset, data });
          }
          offset += data.length;
        }
        if (offset !== blob.size)
          fail("integrity_mismatch", "Captured file shortened during import", blob.sha256);
      } finally {
        await file.close();
      }
    }
    return this.seal(input.id);
  }

  /** Keep the archive immutable while a server-side consumer materializes verified content. */
  async withVerifiedArchive<T>(
    id: string,
    consume: (archive: { manifest: HandoffArchiveManifest; blobsDirectory: string }) => Promise<T>,
  ): Promise<T> {
    return this.serialize(id, async () => {
      const record = await this.readRecord(id);
      if (record.state !== "verified")
        fail("invalid_state", "Verify the archive before restoring it");
      for (const blob of record.manifest.blobs) await this.verifyBlob(id, blob);
      return consume({
        manifest: record.manifest,
        blobsDirectory: path.join(this.location(id), "blobs"),
      });
    });
  }

  async writeChunk(input: ChunkInput): Promise<number> {
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.data.length === 0 ||
      input.data.length > HANDOFF_CHUNK_BYTES
    )
      fail("invalid_chunk", "Invalid handoff chunk bounds");
    // The caller may release or reuse its network buffer before a queued write runs.
    const data = Buffer.from(input.data);
    return this.serialize(
      input.id,
      async () => {
        const record = await this.readRecord(input.id);
        const blob = this.findBlob(record, input.sha256);
        if (input.offset + data.length > blob.size)
          fail("invalid_chunk", "Chunk exceeds declared blob size", blob.sha256);
        const blobPath = path.join(this.location(input.id), "blobs", blob.sha256);
        const file = await open(
          blobPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > blob.size)
            fail("storage_corrupt", "Invalid handoff blob on disk", blob.sha256);
          if (input.offset < stat.size) {
            if (input.offset + data.length > stat.size)
              fail("offset_mismatch", "Retry from the reported blob offset", blob.sha256);
            const previous = Buffer.alloc(data.length);
            let read = 0;
            while (read < previous.length) {
              const part = await file.read(
                previous,
                read,
                previous.length - read,
                input.offset + read,
              );
              if (part.bytesRead === 0)
                fail("storage_corrupt", "Blob shortened during replay", blob.sha256);
              read += part.bytesRead;
            }
            if (!previous.equals(data))
              fail("chunk_mismatch", "Replayed chunk differs from received bytes", blob.sha256);
            return stat.size;
          }
          if (record.state !== "receiving")
            fail("invalid_state", "Verified archives cannot accept new data");
          if (input.offset !== stat.size)
            fail("offset_mismatch", "Retry from the reported blob offset", blob.sha256);
          let written = 0;
          while (written < data.length) {
            const part = await file.write(
              data,
              written,
              data.length - written,
              input.offset + written,
            );
            if (part.bytesWritten === 0)
              fail("storage_corrupt", "Blob write made no progress", blob.sha256);
            written += part.bytesWritten;
          }
          await file.sync();
          if (stat.size === 0) await syncDirectory(path.dirname(blobPath));
          return input.offset + data.length;
        } finally {
          await file.close();
        }
      },
      data.length,
    );
  }

  async resetBlob(id: string, sha256: string): Promise<void> {
    return this.serialize(id, async () => {
      const record = await this.readRecord(id);
      this.findBlob(record, sha256);
      if (record.state !== "receiving") fail("invalid_state", "Cannot reset a verified archive");
      const blobPath = path.join(this.location(id), "blobs", sha256);
      await rm(blobPath, { force: true });
      await syncDirectory(path.dirname(blobPath));
    });
  }

  async seal(id: string): Promise<HandoffArchiveStatus> {
    return this.serialize(id, async () => {
      const record = await this.readRecord(id);
      for (const blob of record.manifest.blobs) await this.verifyBlob(id, blob);
      const verified: ArchiveRecord = { ...record, state: "verified" };
      await writeJournal(path.join(this.location(id), "archive.json"), verified);
      return this.progress(verified);
    });
  }

  async readChunk(input: ReadInput): Promise<Buffer> {
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > HANDOFF_CHUNK_BYTES
    )
      fail("invalid_chunk", "Invalid handoff read bounds");
    return this.serialize(input.id, async () => {
      const record = await this.readRecord(input.id);
      const blob = this.findBlob(record, input.sha256);
      if (record.state !== "verified")
        fail("invalid_state", "Verify the archive before reading it");
      if (input.offset > blob.size) fail("invalid_chunk", "Read offset exceeds blob size");
      const bytes = Buffer.alloc(Math.min(input.length, blob.size - input.offset));
      const file = await open(
        path.join(this.location(input.id), "blobs", blob.sha256),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        let read = 0;
        while (read < bytes.length) {
          const part = await file.read(bytes, read, bytes.length - read, input.offset + read);
          if (part.bytesRead === 0)
            fail("storage_corrupt", "Verified blob was truncated", blob.sha256);
          read += part.bytesRead;
        }
        return bytes;
      } finally {
        await file.close();
      }
    });
  }

  private location(id: string): string {
    TransferIdSchema.parse(id);
    return path.join(this.directory, id);
  }

  private async readRecordOrNull(id: string): Promise<ArchiveRecord | null> {
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(
        path.join(this.location(id), "archive.json"),
        this.limits.maxMetadataBytes + 1024,
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await lstat(this.location(id));
      } catch (statError) {
        if (isMissing(statError)) return null;
        throw statError;
      }
      fail("storage_corrupt", "Handoff archive journal is missing");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) fail("storage_corrupt", "Invalid handoff archive journal");
      throw error;
    }
    const record = RecordSchema.safeParse(value);
    if (!record.success || record.data.id !== id)
      fail("storage_corrupt", "Invalid handoff archive journal");
    canonicalManifest(record.data.manifest, this.limits);
    return record.data;
  }

  private async readRecord(id: string): Promise<ArchiveRecord> {
    const record = await this.readRecordOrNull(id);
    if (!record) fail("not_found", "Handoff archive not found");
    return record;
  }

  private findBlob(record: ArchiveRecord, sha256: string): HandoffBlob {
    const blob = record.manifest.blobs.find((candidate) => candidate.sha256 === sha256);
    if (!blob) fail("not_found", "Blob is not in this handoff archive");
    return blob;
  }

  private async progress(record: ArchiveRecord): Promise<HandoffArchiveStatus> {
    const blobs: BlobProgress[] = [];
    for (const blob of record.manifest.blobs) {
      let receivedBytes = 0;
      try {
        const stat = await lstat(path.join(this.location(record.id), "blobs", blob.sha256));
        if (!stat.isFile() || stat.size > blob.size)
          fail("storage_corrupt", "Invalid handoff blob on disk", blob.sha256);
        receivedBytes = stat.size;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      blobs.push({ ...blob, receivedBytes });
    }
    return { id: record.id, state: record.state, blobs };
  }

  private async verifyBlob(id: string, blob: HandoffBlob): Promise<void> {
    const flags = constants.O_RDWR | constants.O_NOFOLLOW;
    const createEmpty = blob.size === 0 ? constants.O_CREAT : 0;
    let file;
    try {
      file = await open(
        path.join(this.location(id), "blobs", blob.sha256),
        flags | createEmpty,
        0o600,
      );
    } catch (error) {
      if (isMissing(error)) fail("integrity_mismatch", "Blob is incomplete", blob.sha256);
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== blob.size)
        fail("integrity_mismatch", "Blob is incomplete", blob.sha256);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > blob.size) fail("integrity_mismatch", "Blob grew while verifying", blob.sha256);
        hash.update(chunk);
      }
      if (size !== blob.size || hash.digest("hex") !== blob.sha256)
        fail("integrity_mismatch", "Blob checksum differs from the manifest", blob.sha256);
      await file.sync();
      if (blob.size === 0) await syncDirectory(path.join(this.location(id), "blobs"));
    } finally {
      await file.close();
    }
  }

  private async serialize<T>(
    id: string,
    operation: () => Promise<T>,
    retainedBytes = 0,
  ): Promise<T> {
    TransferIdSchema.parse(id);
    if (this.pendingOperations >= 64 || this.pendingBytes + retainedBytes > 32 * 1024 * 1024) {
      fail(
        "limit_exceeded",
        "Too many handoff requests are pending; retry after current requests finish",
      );
    }
    this.pendingOperations += 1;
    this.pendingBytes += retainedBytes;
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      this.pendingOperations -= 1;
      this.pendingBytes -= retainedBytes;
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
}
