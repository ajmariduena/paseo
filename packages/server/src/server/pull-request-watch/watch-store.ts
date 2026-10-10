import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { syncFilePublication, writeJsonFileAtomic } from "../atomic-file.js";
import {
  HandoffPullRequestWatchReviewSchema,
  type HandoffPullRequestWatchReview,
} from "@getpaseo/protocol/handoff-control";

export function reviewPullRequestWatch(watch: PullRequestWatch): HandoffPullRequestWatchReview {
  return HandoffPullRequestWatchReviewSchema.parse(watch);
}

export function assertReviewedPullRequestWatches(
  current: HandoffPullRequestWatchReview[],
  approved: readonly HandoffPullRequestWatchReview[],
) {
  const reviewed = new Set(approved.map((watch) => JSON.stringify(watch)));
  if (current.some((watch) => !reviewed.has(JSON.stringify(watch))))
    throw new Error("PR watches changed after review; cancel this transfer and review again");
}

const WatchProgressSchema = z.object({
  /**
   * The head commit these fields describe; null on forges that report none. Absent on watches
   * saved before it existed, which adopt the current head without treating it as a push.
   */
  headSha: z.string().nullable().optional(),
  failedChecks: z.array(z.string()),
  passed: z.boolean(),
  /** Names in the passing gate, so a required check that first shows up already passed is news. */
  passedChecks: z.array(z.string()).default([]),
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

  constructor(
    private readonly filePath: string,
    private readonly options: { sync?: typeof syncFilePublication } = {},
  ) {}

  async list(): Promise<PullRequestWatch[]> {
    await this.tail.catch(() => {});
    return (await this.read()).watches;
  }

  /** The source fence blocks new registrations; serialize validation and durable removal together. */
  async stopForHandoff(
    agentIds: string[],
    approved: readonly HandoffPullRequestWatchReview[],
  ): Promise<PullRequestWatch[]> {
    const ids = new Set(agentIds);
    return this.mutate((file) => {
      const removed = file.watches.filter((watch) => ids.has(watch.agentId));
      assertReviewedPullRequestWatches(removed.map(reviewPullRequestWatch), approved);
      file.watches = file.watches.filter((watch) => !ids.has(watch.agentId));
      return removed;
    }, true);
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

  private mutate<T>(apply: (file: WatchFile) => T, durable = false): Promise<T> {
    const result = this.tail
      .catch(() => undefined)
      .then(async () => {
        const file = await this.read();
        const value = apply(file);
        await writeJsonFileAtomic(this.filePath, file);
        if (durable)
          await (this.options.sync ?? syncFilePublication)(
            this.filePath,
            path.dirname(this.filePath),
          );
        return value;
      });
    this.tail = result;
    return result;
  }
}
