import { readFile } from "node:fs/promises";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

const WatchProgressSchema = z.object({
  failedChecks: z.array(z.string()),
  passed: z.boolean(),
  /** Epoch ms of the newest remark the agent was told about. */
  remarksThrough: z.number(),
  /** Remarks at exactly `remarksThrough`; forge times are per second. */
  remarkIds: z.array(z.string()),
  conflicting: z.boolean(),
  /** Comment-only wakes in a row. */
  wakes: z.number().int(),
});

const PullRequestWatchSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  cwd: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  headRefName: z.string(),
  startedAt: z.string(),
  progress: WatchProgressSchema,
});

const WatchFileSchema = z.object({
  version: z.literal(1),
  watches: z.array(PullRequestWatchSchema),
});

export type WatchProgress = z.infer<typeof WatchProgressSchema>;
export type PullRequestWatch = z.infer<typeof PullRequestWatchSchema>;
type WatchFile = z.infer<typeof WatchFileSchema>;

/** Every watched pull request in one JSON file; each mutation is one atomic write. */
export class PullRequestWatchStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(): Promise<PullRequestWatch[]> {
    return (await this.read()).watches;
  }

  async get(id: string): Promise<PullRequestWatch | null> {
    return (await this.read()).watches.find((watch) => watch.id === id) ?? null;
  }

  /** Adds the watch unless the agent already watches that pull request; returns the one kept. */
  async add(watch: PullRequestWatch): Promise<{ watch: PullRequestWatch; added: boolean }> {
    return await this.mutate((file) => {
      const existing = file.watches.find(
        (candidate) => candidate.agentId === watch.agentId && candidate.url === watch.url,
      );
      if (existing) return { watch: existing, added: false };
      file.watches.push(watch);
      return { watch, added: true };
    });
  }

  async remove(id: string): Promise<PullRequestWatch | null> {
    return await this.mutate((file) => {
      const removed = file.watches.find((watch) => watch.id === id) ?? null;
      file.watches = file.watches.filter((watch) => watch.id !== id);
      return removed;
    });
  }

  async removeForAgent(agentId: string): Promise<PullRequestWatch[]> {
    return await this.mutate((file) => {
      const removed = file.watches.filter((watch) => watch.agentId === agentId);
      file.watches = file.watches.filter((watch) => watch.agentId !== agentId);
      return removed;
    });
  }

  /** Applies only while the same watch is on, so an unwatch during a forge read wins. */
  async recordProgress(watch: PullRequestWatch, progress: WatchProgress): Promise<boolean> {
    return await this.mutate((file) => {
      const current = file.watches.find(
        (candidate) => candidate.id === watch.id && candidate.startedAt === watch.startedAt,
      );
      if (!current) return false;
      current.progress = progress;
      return true;
    });
  }

  private async read(): Promise<WatchFile> {
    try {
      return WatchFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 1, watches: [] };
      }
      throw error;
    }
  }

  private mutate<T>(apply: (file: WatchFile) => T): Promise<T> {
    const result = this.tail
      .catch(() => undefined)
      .then(async () => {
        const file = await this.read();
        const value = apply(file);
        await writeJsonFileAtomic(this.filePath, file);
        return value;
      });
    this.tail = result;
    return result;
  }
}
