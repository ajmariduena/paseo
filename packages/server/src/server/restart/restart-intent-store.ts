import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

const CutRunSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  /** In-memory run key of the cut run; `crash` when derived from a record after a crash. */
  runKey: z.string(),
  cutAt: z.string(),
});

const RestartIntentFileSchema = z.object({
  version: z.literal(1),
  writtenAt: z.string(),
  cutRuns: z.array(CutRunSchema),
});

export type CutRun = z.infer<typeof CutRunSchema>;
export type RestartIntentFile = z.infer<typeof RestartIntentFileSchema>;

/**
 * What a graceful shutdown cut short, written while providers are still live and consumed once
 * at the next boot. A crash writes nothing; boot derives the same facts from agent records.
 */
export class RestartIntentStore {
  constructor(private readonly filePath: string) {}

  static at(paseoHome: string): RestartIntentStore {
    return new RestartIntentStore(path.join(paseoHome, "runtime", "restart-intents.json"));
  }

  async write(file: RestartIntentFile): Promise<void> {
    await writeJsonFileAtomic(this.filePath, file);
  }

  async read(): Promise<RestartIntentFile | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    return RestartIntentFileSchema.parse(JSON.parse(raw));
  }

  async delete(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
