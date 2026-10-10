import { watch } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createWatcherLivenessCanary } from "./watcher-liveness-canary.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("requires the canary event to round-trip through the watcher callback", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot, { timeoutMs: 1_000 });

  const verification = canary.verify();
  const canaryPath = canary.path;
  expect(canary.filterEvents([{ path: canaryPath, type: "create" }])).toEqual([]);

  await expect(verification).resolves.toBeUndefined();
});

test("rejects when the watcher never reports the canary", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot, { timeoutMs: 10 });

  await expect(canary.verify()).rejects.toThrow("did not report its liveness canary");
  await expect(access(canary.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("verifies a real watcher that becomes ready after the initial canary write", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot, { timeoutMs: 2_000 });
  const verification = canary.verify();
  // The first event is already gone before this watcher exists.
  await expect.poll(() => readFile(canary.path, "utf8")).toBe("paseo watcher liveness canary\n");
  const watcher = watch(watchRoot, (_type, filename) => {
    if (filename?.toString() === basename(canary.path)) {
      canary.filterEvents([{ path: canary.path, type: "update" }]);
    }
  });
  try {
    await expect(verification).resolves.toBeUndefined();
    await expect(access(canary.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    watcher.close();
  }
});

test("aborting verification cancels retries and removes the canary", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot);
  const controller = new AbortController();
  const verification = canary.verify(controller.signal);
  const rejected = expect(verification).rejects.toThrow("Stop observing");
  await expect.poll(() => readFile(canary.path, "utf8")).toBe("paseo watcher liveness canary\n");
  controller.abort(new Error("Stop observing"));
  await rejected;
  await expect(access(canary.path)).rejects.toMatchObject({ code: "ENOENT" });
});
