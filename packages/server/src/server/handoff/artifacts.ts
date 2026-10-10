import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function readBoundedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("Invalid handoff metadata file size");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("Handoff metadata exceeded its byte limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  // Node cannot flush Windows directory handles. Ownership release must remain
  // unavailable there until its durable rename boundary has a native implementation.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeJournal(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await rm(temporary, { force: true });
  }
}
