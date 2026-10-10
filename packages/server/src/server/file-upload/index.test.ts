import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncFilePublication } from "../atomic-file.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { FileUploadStore } from "./index.js";

const tempDirs: string[] = [];

describe("file uploads", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32").each([
    { label: "binary", bytes: Buffer.from([0, 255, 128, 10]) },
    { label: "empty", bytes: Buffer.alloc(0) },
  ])(
    "captures and durably installs a $label queued upload with a stable destination path",
    async ({ bytes }) => {
      const sourceHome = makePaseoHome();
      const destinationHome = makePaseoHome();
      const source = new FileUploadStore({ paseoHome: sourceHome });
      source.beginUpload({
        type: "file.upload.request",
        requestId: "handoff-file",
        fileName: "résumé.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
      });
      await source.receiveFrame(uploadBegins("handoff-file"));
      await source.receiveFrame({
        ...uploadChunk("handoff-file", ""),
        payload: bytes,
      });
      const completed = await source.receiveFrame(uploadEnds("handoff-file"));
      const attachment = completed?.payload.file;
      if (!attachment) throw new Error("Missing uploaded file");
      const blobs = join(sourceHome, "captured");
      const captured = await source.captureForHandoff(attachment, {
        maxBytes: 16,
        directory: blobs,
      });
      expect(captured.attachment).toEqual(attachment);
      let failOnce = true;
      const destination = new FileUploadStore({
        paseoHome: destinationHome,
        sync: async (file, directory) => {
          await syncFilePublication(file, directory);
          if (failOnce) {
            failOnce = false;
            throw new Error("upload sync acknowledgement lost");
          }
        },
      });
      await expect(
        destination.installForHandoff(captured, join(blobs, captured.blob.sha256), "reservation"),
      ).rejects.toThrow("upload sync acknowledgement lost");
      const installed = await new FileUploadStore({ paseoHome: destinationHome }).installForHandoff(
        captured,
        join(blobs, captured.blob.sha256),
        "reservation",
      );
      expect(installed).toMatchObject({
        fileName: "résumé.bin",
        size: bytes.length,
        mimeType: "application/octet-stream",
      });
      expect(installed.path.startsWith(destinationHome)).toBe(true);
      expect(installed.id).not.toBe(attachment.id);
      expect(await readFile(installed.path)).toEqual(bytes);
      expect(
        await new FileUploadStore({ paseoHome: destinationHome }).installForHandoff(
          captured,
          join(blobs, captured.blob.sha256),
          "reservation",
        ),
      ).toEqual(installed);
      await writeFile(installed.path, "changed");
      await expect(
        destination.installForHandoff(captured, join(blobs, captured.blob.sha256), "reservation"),
      ).rejects.toThrow("differs");
      expect(await readFile(installed.path, "utf8")).toBe("changed");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses foreign paths, changed sizes and symlinked upload files or directories",
    async () => {
      const paseoHome = makePaseoHome();
      const uploads = new FileUploadStore({ paseoHome });
      const directory = join(paseoHome, "uploads", "upload_legacy-request");
      await mkdir(directory, { recursive: true });
      const attachment = {
        type: "uploaded_file" as const,
        id: "upload_legacy-request",
        path: join(directory, "data.bin"),
        fileName: "data.bin",
        mimeType: "application/octet-stream",
        size: 4,
      };
      await writeFile(attachment.path, "data");
      await expect(
        uploads.captureForHandoff(
          { ...attachment, path: join(paseoHome, "outside") },
          { maxBytes: 10 },
        ),
      ).rejects.toThrow("outside its source store");
      await expect(
        uploads.captureForHandoff({ ...attachment, size: 3 }, { maxBytes: 10 }),
      ).rejects.toThrow("size differs");
      await expect(uploads.captureForHandoff(attachment, { maxBytes: 3 })).rejects.toThrow(
        "file size",
      );
      const outside = join(paseoHome, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "data.bin"), "data");
      await rm(attachment.path);
      await symlink(join(outside, "data.bin"), attachment.path);
      await expect(uploads.captureForHandoff(attachment, { maxBytes: 10 })).rejects.toMatchObject({
        code: "ELOOP",
      });
      await rm(directory, { recursive: true });
      await symlink(outside, directory);
      await expect(uploads.captureForHandoff(attachment, { maxBytes: 10 })).rejects.toThrow(
        "not a real directory",
      );
      expect(await readFile(join(outside, "data.bin"), "utf8")).toBe("data");
    },
  );

  it("stores chunked upload bytes and returns an uploaded-file attachment", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-upload"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", "hello"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", " world"))).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-upload"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("keeps the original file name for non-ASCII and punctuated names", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    for (const fileName of [
      "2026年9月绩效计划表.xlsx",
      "테스트 파일 (1).xlsx",
      "résumé [final] & notes, v2.pdf",
      "cafe\u0301 हिंदी.txt",
    ]) {
      const file = await uploadNamed(uploads, fileName);
      expect(file?.fileName).toBe(fileName);
      expect(basename(file!.path)).toBe(fileName);
      expect(readFileSync(file!.path, "utf8")).toBe("hello world");
    }
  });

  it("replaces path separators, control characters, and characters Windows rejects", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    await expect(uploadNamed(uploads, "../../etc/passwd")).resolves.toMatchObject({
      fileName: "passwd",
    });
    const backslashed = await uploadNamed(uploads, "dir\\name.txt");
    expect(backslashed?.fileName).not.toContain("\\");
    expect(backslashed?.fileName).toMatch(/name\.txt$/);
    await expect(uploadNamed(uploads, 'a<b>:"c|?*.txt')).resolves.toMatchObject({
      fileName: "a_b___c___.txt",
    });
    await expect(uploadNamed(uploads, "line\nbreak.txt")).resolves.toMatchObject({
      fileName: "line_break.txt",
    });
  });

  it("shortens a long non-ASCII name to the file system limit and keeps its extension", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    const file = await uploadNamed(uploads, `${"绩".repeat(100)}.xlsx`);

    expect(file?.fileName).toBe(`${"绩".repeat(83)}.xlsx`);
    expect(Buffer.byteLength(file!.fileName)).toBeLessThanOrEqual(255);
    expect(readFileSync(file!.path, "utf8")).toBe("hello world");
  });

  it("rejects chunks beyond the declared size and removes the partial file", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-overflow",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-overflow"))).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    const uploadDir = dirname(path);
    await expect(uploads.receiveFrame(uploadChunk("req-overflow", "hello!"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-overflow",
        file: null,
        error: "Upload exceeded declared size: expected 5, received 6.",
      },
    });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
  });

  it("preserves chunk order when frames arrive before earlier disk writes finish", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-queued",
    });

    const results = await Promise.all([
      uploads.receiveFrame(uploadBegins("req-queued")),
      uploads.receiveFrame(uploadChunk("req-queued", "hello")),
      uploads.receiveFrame(uploadChunk("req-queued", " world")),
      uploads.receiveFrame(uploadEnds("req-queued")),
    ]);

    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]?.payload.error).toBeNull();
    expect(readFileSync(uploadedPath(paseoHome, "notes.txt"), "utf8")).toBe("hello world");
  });

  it("replaces duplicate upload starts without letting the old stale timeout evict the replacement", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "old.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "old"))).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(25);
    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "new.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await vi.advanceTimersByTimeAsync(30);

    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "new"))).resolves.toBeNull();
    const path = uploadedPath(paseoHome, "new.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-duplicate"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-duplicate",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "new.txt",
          mimeType: "text/plain",
          size: 3,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("keeps an active upload alive beyond the initial stale timeout", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-slow-active",
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(uploads.receiveFrame(uploadBegins("req-slow-active"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(uploads.receiveFrame(uploadChunk("req-slow-active", "hello"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(
      uploads.receiveFrame(uploadChunk("req-slow-active", " world")),
    ).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-slow-active"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-slow-active",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });
});

let uploadCount = 0;

async function uploadNamed(uploads: FileUploadStore, fileName: string) {
  const requestId = `req-named-${uploadCount++}`;
  uploads.beginUpload({
    type: "file.upload.request",
    fileName,
    mimeType: "text/plain",
    size: 11,
    modifiedAt: "2026-05-02T00:00:00.000Z",
    requestId,
  });
  await uploads.receiveFrame(uploadBegins(requestId));
  await uploads.receiveFrame(uploadChunk(requestId, "hello world"));
  const response = await uploads.receiveFrame(uploadEnds(requestId));
  expect(response?.payload.error).toBeNull();
  return response?.payload.file;
}

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-upload-test-")));
  tempDirs.push(root);
  return root;
}

function uploadBegins(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: 11,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        fileName: "notes.txt",
      },
    }),
  );
}

function uploadChunk(requestId: string, text: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId,
      payload: new TextEncoder().encode(text),
    }),
  );
}

function uploadEnds(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
    }),
  );
}

function decodeUploadFrame(bytes: Uint8Array): FileTransferFrame {
  const frame = decodeFileTransferFrame(bytes);
  if (!frame) {
    throw new Error("Expected file transfer frame");
  }
  return frame;
}

function uploadedPath(paseoHome: string, fileName: string): string {
  const root = join(paseoHome, "uploads");
  const file = readdirSync(root)
    .map((id) => join(root, id, fileName))
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`Upload file ${fileName} is missing`);
  return file;
}
