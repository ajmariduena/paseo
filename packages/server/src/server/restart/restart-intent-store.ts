import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { syncFilePublication, writeJsonFileAtomic } from "../atomic-file.js";

const CutRunSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  /** In-memory run key of the cut run; `crash:{updatedAt}` when derived from a record. */
  runKey: z.string(),
  cutAt: z.string(),
  /** Someone asked the run to stop before the restart cut it. */
  stopRequested: z.boolean().default(false),
  /** An out-of-band command was running, not a turn worth continuing. */
  outOfBand: z.boolean().default(false),
});

const RestartCancelledWorkSchema = z.object({
  kind: z.string(),
  label: z.string(),
  id: z.string(),
});

const RestartIntentFileSchema = z.object({
  version: z.literal(1),
  writtenAt: z.string(),
  cutRuns: z.array(CutRunSchema),
  /** Background tasks each agent held when the daemon stopped. */
  backgroundWork: z.record(z.string(), z.array(RestartCancelledWorkSchema)).default({}),
});

export type CutRun = z.infer<typeof CutRunSchema>;
export type RestartIntentFile = z.infer<typeof RestartIntentFileSchema>;

/**
 * What a graceful shutdown cut short, retained until boot has handled it. A crash writes
 * nothing; boot derives cut runs from agent records but cannot reconstruct background tasks.
 */
export class RestartIntentStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static at(paseoHome: string): RestartIntentStore {
    return new RestartIntentStore(path.join(paseoHome, "runtime", "restart-intents.json"));
  }

  async write(file: RestartIntentFile): Promise<void> {
    const snapshot = structuredClone(file);
    await this.mutate(async () => {
      const previous = await this.read();
      const backgroundWork = previous?.backgroundWork ?? {};
      for (const [agentId, work] of Object.entries(snapshot.backgroundWork)) {
        const merged = new Map((backgroundWork[agentId] ?? []).map((entry) => [entry.id, entry]));
        for (const entry of work) merged.set(entry.id, entry);
        backgroundWork[agentId] = [...merged.values()];
      }
      // Only the current shutdown determines which turns may continue. Older notes remain
      // obligations even if boot could not save them before this shutdown started.
      await writeJsonFileAtomic(this.filePath, { ...snapshot, backgroundWork });
      if (process.platform !== "win32") {
        await syncFilePublication(this.filePath, path.dirname(path.dirname(this.filePath)));
      }
    });
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

  /** An older boot's continuation must not remove a newer shutdown's recovery input. */
  async consume(expected: RestartIntentFile | null): Promise<void> {
    const snapshot = structuredClone(expected);
    await this.mutate(async () => {
      const current = await this.read();
      if (JSON.stringify(current) === JSON.stringify(snapshot)) {
        await rm(this.filePath, { force: true });
      }
    });
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const next = this.mutation.catch(() => undefined).then(operation);
    this.mutation = next;
    return next;
  }
}
