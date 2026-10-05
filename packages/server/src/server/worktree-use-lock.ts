import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const pending = new Map<string, Promise<void>>();

export async function withWorktreeProjectLock<T>(
  projectRoot: string,
  action: () => Promise<T>,
): Promise<T> {
  let key: string;
  try {
    key = realpathSync(projectRoot);
  } catch {
    try {
      key = join(realpathSync(dirname(projectRoot)), basename(projectRoot));
    } catch {
      key = resolve(projectRoot);
    }
  }
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  pending.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}

export function worktreeProjectRootForCwd(cwd: string): string | null {
  let current: string;
  try {
    current = realpathSync(cwd);
  } catch {
    return null;
  }
  let worktreeRoot: string | null = null;
  while (true) {
    try {
      if (statSync(join(current, ".git")).isFile()) worktreeRoot = current;
    } catch {
      // Walk to the parent until a managed worktree's .git file is found.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return worktreeRoot ? dirname(worktreeRoot) : null;
}
