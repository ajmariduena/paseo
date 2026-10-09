import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

/** The encoding every JSON store writes, so size caps can measure what lands on disk. */
export function encodeJsonFile(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const NO_LINK_SUPPORT = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "EMLINK"]);

type TempHandle = Pick<FileHandle, "writeFile" | "sync" | "close">;

/** The filesystem operations create-once publication depends on, so tests can take them away. */
export interface CreateOncePort {
  link: (existingPath: string, newPath: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  open: (filePath: string, flags: "w") => Promise<TempHandle>;
}

export const REAL_CREATE_ONCE_PORT: CreateOncePort = {
  link: fs.link,
  rename: fs.rename,
  open: fs.open,
};

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/**
 * Publishes a file only if nothing exists at the path yet. The content is written in full and
 * fsynced to a temp file first, so the final path never holds partial data. A hard link from
 * that temp file is the atomic create-once route. Where the filesystem has no hard links the
 * temp file is renamed into place after checking the destination is absent; callers serialize
 * same-path publication in process, and the remaining check-then-rename race between two
 * processes sharing one directory is accepted on those filesystems only. A failed write leaves
 * neither file behind.
 */
export async function writeJsonFileCreateOnce(
  filePath: string,
  value: unknown,
  io: CreateOncePort = REAL_CREATE_ONCE_PORT,
): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await writeTempFile(tempPath, encodeJsonFile(value), io);
    try {
      await io.link(tempPath, filePath);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") return false;
      if (code === null || !NO_LINK_SUPPORT.has(code)) throw error;
    }
    if (await exists(filePath)) return false;
    await io.rename(tempPath, filePath);
    return true;
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function writeTempFile(tempPath: string, content: string, io: CreateOncePort): Promise<void> {
  const handle = await io.open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}
