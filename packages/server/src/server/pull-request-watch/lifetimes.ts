import type { Logger } from "pino";

import type { PullRequestWatch } from "./watch-store.js";

/**
 * Why a watch ended. `stopped` is a watch that left the store some other way between two
 * passes.
 */
export type WatchEndReason =
  | "merged"
  | "closed"
  | "unreadable"
  | "comment-limit"
  | "unwatched"
  | "archived"
  | "subagent"
  | "stopped";

interface WatchLife {
  agentId: string;
  pullRequest: string;
  startedAt: number;
  /** The head commit the last successful read saw. */
  headSha: string | null;
  /** When a read last saw the head commit move, or the start. */
  pushedAt: number;
  /** Longest time between pushes, not counting the time since the last one. */
  longestQuietMs: number;
  wakes: number;
  reads: number;
}

function minutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

/**
 * What each watch did while this daemon ran, logged once when it ends so we can see how long
 * watches stay quiet. Kept in memory: a watch older than the daemon has partial numbers, and one
 * that ends while the daemon is down is not logged.
 */
export class WatchLifetimes {
  private readonly lives = new Map<string, WatchLife>();
  private readonly bootedAt: number;

  constructor(
    private readonly now: () => number,
    private readonly logger: Logger,
  ) {
    this.bootedAt = now();
  }

  read(watch: PullRequestWatch, headSha: string | null): void {
    const life = this.lifeOf(watch);
    // The first read only learns the head, so it is not a push.
    if (life.headSha !== null && headSha !== life.headSha) {
      const now = this.now();
      life.longestQuietMs = Math.max(life.longestQuietMs, now - life.pushedAt);
      life.pushedAt = now;
    }
    life.headSha = headSha;
    life.reads += 1;
  }

  woke(watch: PullRequestWatch): void {
    this.lifeOf(watch).wakes += 1;
  }

  ended(watch: PullRequestWatch, reason: WatchEndReason): void {
    this.report(watch.id, this.lifeOf(watch), reason);
  }

  /** Logs the watches seen before that are no longer in the store. */
  endMissing(present: PullRequestWatch[]): void {
    const ids = new Set(present.map((watch) => watch.id));
    for (const [id, life] of this.lives) {
      if (!ids.has(id)) this.report(id, life, "stopped");
    }
  }

  private lifeOf(watch: PullRequestWatch): WatchLife {
    const existing = this.lives.get(watch.id);
    if (existing) return existing;
    const startedAt = Date.parse(watch.startedAt);
    const life: WatchLife = {
      agentId: watch.agentId,
      pullRequest: watch.url,
      startedAt,
      headSha: watch.progress.headSha ?? null,
      pushedAt: startedAt,
      longestQuietMs: 0,
      wakes: 0,
      reads: 0,
    };
    this.lives.set(watch.id, life);
    return life;
  }

  private report(id: string, life: WatchLife, reason: WatchEndReason): void {
    this.lives.delete(id);
    const now = this.now();
    const quietMs = now - life.pushedAt;
    this.logger.info(
      {
        watchId: id,
        agentId: life.agentId,
        pullRequest: life.pullRequest,
        reason,
        minutes: minutes(now - life.startedAt),
        quietMinutes: minutes(quietMs),
        longestQuietMinutes: minutes(Math.max(life.longestQuietMs, quietMs)),
        wakes: life.wakes,
        reads: life.reads,
        partial: life.startedAt < this.bootedAt,
      },
      "pull_request_watch.ended",
    );
  }
}
