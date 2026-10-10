import type { Logger } from "pino";
import { sweepOwnedArchivedWorktrees, type WorktreeStorageContext } from "./worktree-storage.js";

const START_DELAY_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

export interface WorktreeStorageSweeper {
  scheduleSoon(): void;
  dispose(): Promise<void>;
}

export function startWorktreeStorageSweeper(options: {
  context: WorktreeStorageContext;
  isEnabled(): boolean;
  logger: Logger;
}): WorktreeStorageSweeper {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;

  function schedule(delayMs: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delayMs);
    timer.unref();
  }

  function run(): Promise<void> {
    timer = null;
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = sweep().finally(() => {
      running = null;
      schedule(SWEEP_INTERVAL_MS);
    });
    return running;
  }

  async function sweep(): Promise<void> {
    try {
      if (!options.isEnabled()) return;
      const result = await sweepOwnedArchivedWorktrees(
        options.context,
        () => !stopped && options.isEnabled(),
      );
      for (const path of result.removedPaths) {
        options.logger.info({ path }, "Automatically removed archived worktree");
      }
      for (const failure of result.failures) {
        options.logger.warn(failure, "Automatic worktree cleanup failed; retained worktree");
      }
      options.logger.info(
        {
          scanned: result.scanned,
          candidates: result.candidates,
          removed: result.removed,
          failed: result.failures.length,
        },
        "Automatic worktree cleanup sweep completed",
      );
    } catch (error) {
      options.logger.warn({ err: error }, "Automatic worktree cleanup sweep failed");
    }
  }

  schedule(START_DELAY_MS);
  return {
    scheduleSoon: () => schedule(START_DELAY_MS),
    dispose: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      return running ?? Promise.resolve();
    },
  };
}
