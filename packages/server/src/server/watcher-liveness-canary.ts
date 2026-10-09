import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FileChange } from "./file-observer/index.js";

export const WATCHER_LIVENESS_CANARY_TIMEOUT_MS = 10_000;
const CANARY_CONTENT = "paseo watcher liveness canary\n";

async function repeatCanaryWrite(canaryPath: string, signal: AbortSignal): Promise<never> {
  for (;;) {
    await delay(250, undefined, { signal });
    // A native watcher can become ready after the first write. A later update
    // must still round-trip through its callback; writing alone proves nothing.
    await writeFile(canaryPath, CANARY_CONTENT, { flag: "r+" });
  }
}

export interface WatcherLivenessCanary {
  readonly path: string;
  filterEvents(events: FileChange[]): FileChange[];
  verify(signal?: AbortSignal): Promise<void>;
}

export function createWatcherLivenessCanary(
  watchRoot: string,
  options: { timeoutMs?: number } = {},
): WatcherLivenessCanary {
  const canaryPath = join(watchRoot, `.paseo-watcher-canary-${randomUUID()}`);
  const timeoutMs = options.timeoutMs ?? WATCHER_LIVENESS_CANARY_TIMEOUT_MS;
  let reportCanary!: () => void;
  const reported = new Promise<void>((resolve) => {
    reportCanary = resolve;
  });

  return {
    path: canaryPath,
    filterEvents(events) {
      const filtered = events.filter((event) => event.path !== canaryPath);
      if (filtered.length !== events.length) {
        reportCanary();
      }
      return filtered;
    },
    async verify(signal) {
      await writeFile(canaryPath, CANARY_CONTENT, { flag: "wx" });
      const retryController = new AbortController();
      const retries = repeatCanaryWrite(canaryPath, retryController.signal);
      let timeout: NodeJS.Timeout | null = null;
      let removeAbortListener = () => {};
      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Watcher for ${watchRoot} did not report its liveness canary within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        });
        const abortPromise = new Promise<never>((_resolve, reject) => {
          if (!signal) return;
          const rejectForAbort = () => reject(signal.reason);
          if (signal.aborted) {
            rejectForAbort();
            return;
          }
          signal.addEventListener("abort", rejectForAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", rejectForAbort);
        });
        await Promise.race([reported, timeoutPromise, abortPromise, retries]);
      } finally {
        if (timeout) clearTimeout(timeout);
        removeAbortListener();
        retryController.abort();
        // Teardown is a barrier: an in-flight write must finish before removal.
        await Promise.allSettled([retries]);
        await rm(canaryPath, { force: true });
      }
    },
  };
}
