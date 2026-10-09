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
/** A fallback write older than this that still is not complete JSON was abandoned mid-write. */
const ABANDONED_PARTIAL_WRITE_MS = 60_000;

type ExclusiveHandle = Pick<FileHandle, "writeFile" | "sync" | "close">;

/** The filesystem operations create-once publication depends on, so tests can take them away. */
export interface CreateOncePort {
  link: (existingPath: string, newPath: string) => Promise<void>;
  open: (filePath: string, flags: "wx") => Promise<ExclusiveHandle>;
}

const realPort: CreateOncePort = { link: fs.link, open: fs.open };

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/**
 * Publishes a file only if nothing exists at the path yet; concurrent callers see exactly one
 * winner. A hard link from the finished temp file is the atomic route. Where the filesystem has
 * no hard links the file is created exclusively and written in place, which still admits one
 * winner but can expose a partially written file to a concurrent reader for the write's
 * duration. A failed in-place write removes its file; a partial file nobody finished within a
 * minute counts as abandoned and is replaced.
 */
export async function writeJsonFileCreateOnce(
  filePath: string,
  value: unknown,
  io: CreateOncePort = realPort,
): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = encodeJsonFile(value);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await io.link(tempPath, filePath);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return false;
    if (code !== null && NO_LINK_SUPPORT.has(code)) {
      return await createExclusively(filePath, content, io);
    }
    throw error;
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function createExclusively(
  filePath: string,
  content: string,
  io: CreateOncePort,
): Promise<boolean> {
  let handle: ExclusiveHandle;
  try {
    handle = await io.open(filePath, "wx");
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    if (!(await isAbandonedPartialWrite(filePath))) return false;
    await fs.rm(filePath, { force: true });
    return await createExclusively(filePath, content, io);
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(filePath, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

async function isAbandonedPartialWrite(filePath: string): Promise<boolean> {
  let text: string;
  let modifiedAt: number;
  try {
    const [stats, raw] = await Promise.all([fs.stat(filePath), fs.readFile(filePath, "utf8")]);
    modifiedAt = stats.mtimeMs;
    text = raw;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  try {
    JSON.parse(text);
    return false;
  } catch {
    return Date.now() - modifiedAt > ABANDONED_PARTIAL_WRITE_MS;
  }
}
