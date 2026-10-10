import { createHash, randomUUID } from "node:crypto";
import { appendFile, link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileUploadRequest, FileUploadResponse } from "../messages.js";
import {
  UploadedFileAttachmentSchema,
  type UploadedFileAttachment,
} from "@getpaseo/protocol/messages";
import { HandoffBlobSchema } from "@getpaseo/protocol/handoff";
import { readBoundedFile } from "../handoff/artifacts.js";
import { syncFilePublication, writeFileAtomic } from "../atomic-file.js";

export const CapturedUploadSchema = z.object({
  attachment: UploadedFileAttachmentSchema,
  blob: HandoffBlobSchema,
});
export type CapturedUpload = z.infer<typeof CapturedUploadSchema>;
export const HANDOFF_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

export function parseCapturedUpload(value: unknown): CapturedUpload {
  const captured = CapturedUploadSchema.parse(value);
  validateUploadMetadata(captured.attachment);
  if (
    captured.blob.size !== captured.attachment.size ||
    captured.blob.size > HANDOFF_UPLOAD_MAX_BYTES
  )
    throw new Error("Captured upload size differs from its attachment");
  return captured;
}

interface FileUploadStoreOptions {
  paseoHome: string;
  staleUploadTimeoutMs?: number;
  sync?: typeof syncFilePublication;
}

interface PendingUpload {
  requestId: string;
  id: string;
  source: object;
  completed: boolean;
  finished(response: FileUploadResponse | null): void;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  receivedBytes: number;
  started: boolean;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  cleanup?: Promise<void>;
}

export class FileUploadStore {
  private static readonly defaultStaleUploadTimeoutMs = 10 * 60 * 1000;

  private readonly paseoHome: string;
  private readonly staleUploadTimeoutMs: number;
  private readonly sync: typeof syncFilePublication;
  private readonly defaultSource = {};
  private readonly pending = new Map<object, Map<string, PendingUpload>>();

  constructor(options: FileUploadStoreOptions) {
    this.paseoHome = options.paseoHome;
    this.sync = options.sync ?? syncFilePublication;
    this.staleUploadTimeoutMs =
      options.staleUploadTimeoutMs ?? FileUploadStore.defaultStaleUploadTimeoutMs;
  }

  /** Read only files owned by this upload store, never a path supplied by an imported archive. */
  async captureForHandoff(
    attachment: UploadedFileAttachment,
    options: { maxBytes: number; directory?: string },
  ): Promise<CapturedUpload> {
    validateUploadMetadata(attachment);
    const root = join(this.paseoHome, "uploads");
    const directory = join(root, attachment.id);
    const filePath = join(directory, attachment.fileName);
    if (resolve(attachment.path) !== resolve(filePath))
      throw new Error("Queued upload is outside its source store");
    await requireDirectory(root);
    await requireDirectory(directory);
    const bytes = await readBoundedFile(
      filePath,
      Math.min(options.maxBytes, HANDOFF_UPLOAD_MAX_BYTES),
    );
    if (bytes.length !== attachment.size)
      throw new Error("Queued upload size differs from its attachment");
    const blob = { sha256: sha256(bytes), size: bytes.length };
    if (options.directory) {
      const capturedPath = join(options.directory, blob.sha256);
      await writeFileAtomic(capturedPath, bytes);
      await this.sync(capturedPath, options.directory);
    }
    return { attachment, blob };
  }

  /** Link a complete durable file into its reserved path; a retry cannot replace other bytes. */
  async installForHandoff(
    input: CapturedUpload,
    blobPath: string,
    reservationId: string,
  ): Promise<UploadedFileAttachment> {
    const captured = parseCapturedUpload(input);
    const bytes = await readBoundedFile(blobPath, captured.blob.size);
    requireUploadBytes(bytes, captured);
    const id = `upload_handoff_${sha256(JSON.stringify([reservationId, captured]))}`;
    const root = join(this.paseoHome, "uploads");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await requireDirectory(root);
    const directory = join(root, id);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, "EEXIST")) throw error;
    });
    await requireDirectory(directory);
    const filePath = join(directory, captured.attachment.fileName);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, filePath).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) throw error;
      });
      requireUploadBytes(await readBoundedFile(filePath, HANDOFF_UPLOAD_MAX_BYTES), captured);
      await this.sync(filePath, this.paseoHome);
    } finally {
      await rm(temporary, { force: true });
    }
    return { ...captured.attachment, id, path: filePath };
  }

  beginUpload(
    request: FileUploadRequest,
    source: object = this.defaultSource,
    finished: (response: FileUploadResponse | null) => void = () => {},
  ): () => Promise<void> {
    const existingUpload = this.pending.get(source)?.get(request.requestId);
    if (existingUpload) void this.cancel(existingUpload).catch(() => {});
    const fileName = sanitizeFileName(request.fileName);
    const id = `upload_${randomUUID()}`;
    const uploadDir = join(this.paseoHome, "uploads", id);
    const upload: PendingUpload = {
      requestId: request.requestId,
      id,
      source,
      completed: false,
      finished,
      fileName,
      mimeType: request.mimeType,
      size: request.size,
      path: join(uploadDir, fileName),
      receivedBytes: 0,
      started: false,
      staleTimeout: this.createStaleUploadTimeout(source, request.requestId),
      queue: Promise.resolve(),
    };
    const uploads = this.pending.get(source) ?? new Map<string, PendingUpload>();
    uploads.set(request.requestId, upload);
    this.pending.set(source, uploads);
    return () => this.cancel(upload);
  }

  async receiveFrame(
    frame: FileTransferFrame,
    source: object = this.defaultSource,
  ): Promise<FileUploadResponse | null> {
    const upload = this.pending.get(source)?.get(frame.requestId);
    if (!upload) {
      return null;
    }
    this.refreshStaleUploadTimeout(upload);

    const operation = upload.queue.then(() => this.applyFrame(upload, frame));
    void operation.then(
      (response) => {
        if (response) upload.finished(response);
        return undefined;
      },
      () => upload.finished(null),
    );
    upload.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyFrame(
    upload: PendingUpload,
    frame: FileTransferFrame,
  ): Promise<FileUploadResponse | null> {
    if (this.pending.get(upload.source)?.get(upload.requestId) !== upload) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        await this.startWriting(upload);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await this.writeChunk(upload, frame.payload);
        return null;
      }
      return await this.completeUpload(upload);
    } catch (error) {
      await this.removeFailedUpload(upload);
      return buildUploadResponse(upload, getErrorMessage(error));
    }
  }

  private async startWriting(upload: PendingUpload): Promise<void> {
    await mkdir(join(this.paseoHome, "uploads", upload.id), { recursive: true });
    await writeFile(upload.path, new Uint8Array());
    upload.started = true;
  }

  private async writeChunk(upload: PendingUpload, bytes: Uint8Array): Promise<void> {
    if (!upload.started) {
      throw new Error("Upload chunks arrived before file begin.");
    }
    const nextReceivedBytes = upload.receivedBytes + bytes.byteLength;
    if (nextReceivedBytes > upload.size) {
      throw new Error(
        `Upload exceeded declared size: expected ${upload.size}, received ${nextReceivedBytes}.`,
      );
    }
    await appendFile(upload.path, bytes);
    upload.receivedBytes += bytes.byteLength;
  }

  private async completeUpload(upload: PendingUpload): Promise<FileUploadResponse> {
    this.clearPendingUpload(upload);
    if (upload.receivedBytes !== upload.size) {
      await this.removeUploadDirectory(upload);
      return buildUploadResponse(
        upload,
        `Upload size mismatch: expected ${upload.size}, received ${upload.receivedBytes}.`,
      );
    }
    upload.completed = true;
    return buildUploadResponse(upload, null);
  }

  private createStaleUploadTimeout(
    source: object,
    requestId: string,
  ): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      const upload = this.pending.get(source)?.get(requestId);
      if (upload) void this.cancel(upload).catch(() => {});
    }, this.staleUploadTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleUploadTimeout(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    upload.staleTimeout = this.createStaleUploadTimeout(upload.source, upload.requestId);
  }

  private cancel(upload: PendingUpload): Promise<void> {
    if (upload.cleanup) return upload.cleanup;
    this.clearPendingUpload(upload);
    upload.cleanup = upload.queue.then(async () => {
      if (!upload.completed) await this.removeUploadDirectory(upload);
      return undefined;
    });
    upload.finished(null);
    return upload.cleanup;
  }

  private clearPendingUpload(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    const uploads = this.pending.get(upload.source);
    if (uploads?.get(upload.requestId) === upload) uploads.delete(upload.requestId);
    if (uploads?.size === 0) this.pending.delete(upload.source);
  }

  private async removeFailedUpload(upload: PendingUpload): Promise<void> {
    this.clearPendingUpload(upload);
    await this.removeUploadDirectory(upload);
  }

  private async removeUploadDirectory(upload: PendingUpload): Promise<void> {
    await rm(join(this.paseoHome, "uploads", upload.id), { recursive: true, force: true });
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function requireDirectory(directory: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Upload directory is not a real directory");
}

function validateUploadMetadata(attachment: UploadedFileAttachment): void {
  if (
    !/^upload_[a-zA-Z0-9_-]{1,240}$/.test(attachment.id) ||
    !attachment.path ||
    sanitizeFileName(attachment.fileName) !== attachment.fileName
  )
    throw new Error("Invalid queued upload identity or filename");
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireUploadBytes(bytes: Buffer, captured: CapturedUpload): void {
  if (bytes.length !== captured.blob.size || sha256(bytes) !== captured.blob.sha256)
    throw new Error("Queued upload content differs from its captured bytes");
}

function buildUploadResponse(upload: PendingUpload, error: string | null): FileUploadResponse {
  return {
    type: "file.upload.response",
    payload: {
      requestId: upload.requestId,
      file: error
        ? null
        : {
            type: "uploaded_file",
            id: upload.id,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            size: upload.size,
            path: upload.path,
          },
      error,
    },
  };
}

// Most file systems cap a single file name at 255 bytes.
const MAX_FILE_NAME_BYTES = 255;

// Keeps the client's file name, replacing only what cannot appear in a single
// file name on Linux, macOS, or Windows.
function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[\p{Cc}\\/:*?"<>|]/gu, "_")
    .trim();
  return fitFileNameLength(name.length > 0 && name !== "." && name !== ".." ? name : "upload");
}

function fitFileNameLength(name: string): string {
  if (Buffer.byteLength(name) <= MAX_FILE_NAME_BYTES) return name;
  const extension = extname(name);
  const keptExtension = Buffer.byteLength(extension) < MAX_FILE_NAME_BYTES ? extension : "";
  let stem = "";
  for (const char of name.slice(0, name.length - keptExtension.length)) {
    if (Buffer.byteLength(stem + char + keptExtension) > MAX_FILE_NAME_BYTES) break;
    stem += char;
  }
  return stem + keptExtension;
}
