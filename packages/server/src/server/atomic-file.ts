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

/** Flush a published file and the directories created by its atomic writer. */
export async function syncFilePublication(filePath: string, directoryRoot: string): Promise<void> {
  if (process.platform === "win32")
    throw new Error("Durable directory publication is unavailable on Windows");
  let directory = path.dirname(path.resolve(filePath));
  const root = path.resolve(directoryRoot);
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Publication root does not contain the file");
  const file = await fs.open(filePath, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  for (;;) {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
}
