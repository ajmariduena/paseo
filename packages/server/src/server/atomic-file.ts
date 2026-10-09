import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/**
 * Publishes a file only if nothing exists at the path yet; concurrent callers see exactly one
 * winner. A hard link from the finished temp file is the atomic route. Where the filesystem has
 * no hard links the file is created exclusively and written in place, which still admits one
 * winner but can expose a partially written file to a concurrent reader for the write's duration.
 */
export async function writeJsonFileCreateOnce(
  filePath: string,
  value: unknown,
  io: Pick<typeof fs, "link"> = fs,
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
      return await createExclusively(filePath, content);
    }
    throw error;
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function createExclusively(filePath: string, content: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}
