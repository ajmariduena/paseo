import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

const StateFileSchema = z.object({
  version: z.literal(1),
  glassesPairedAt: z.string(),
});

const SummariesFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.tuple([z.string(), z.string()])),
});

export type GlanceSummaryEntry = [key: string, line: string];

/** Glance state lives beside config.json, not in it: older daemons reject unknown config keys. */
export class GlanceStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  static forPaseoHome(paseoHome: string): GlanceStore {
    return new GlanceStore(path.join(paseoHome, "glance"));
  }

  async readGlassesPairedAt(): Promise<string | null> {
    const file = await this.readJson(this.statePath, StateFileSchema);
    return file?.glassesPairedAt ?? null;
  }

  markGlassesPaired(at: Date): Promise<void> {
    return this.enqueue(async () => {
      if (await this.readJson(this.statePath, StateFileSchema)) return;
      await writeJsonFileAtomic(this.statePath, { version: 1, glassesPairedAt: at.toISOString() });
    });
  }

  /** Least recently used first. */
  async readSummaries(): Promise<GlanceSummaryEntry[]> {
    const file = await this.readJson(this.summariesPath, SummariesFileSchema);
    return file?.entries ?? [];
  }

  writeSummaries(entries: readonly GlanceSummaryEntry[]): Promise<void> {
    const snapshot = entries.map(([key, line]): GlanceSummaryEntry => [key, line]);
    return this.enqueue(() =>
      writeJsonFileAtomic(this.summariesPath, { version: 1, entries: snapshot }),
    );
  }

  private get statePath(): string {
    return path.join(this.directory, "state.json");
  }

  private get summariesPath(): string {
    return path.join(this.directory, "summaries.json");
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.writes.then(write);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }
}
