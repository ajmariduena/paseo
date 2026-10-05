import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPathInsideRoot } from "../utils/path.js";

const pending = new Map<string, Promise<void>>();
const cleanupReservations = new Set<string>();

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

export async function withWorktreeCleanupReservation<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = resolve(path);
  // Teardown may start another Paseo agent, so hold the reservation without holding the mutex.
  await withWorktreeProjectLock(dirname(key), async () => {
    if (cleanupReservations.has(key)) throw new Error("Worktree is cleaning up");
    cleanupReservations.add(key);
  });
  try {
    return await action();
  } finally {
    cleanupReservations.delete(key);
  }
}

export function assertWorktreeNotCleaningUp(cwd: string): void {
  for (const path of cleanupReservations) {
    if (isPathInsideRoot(path, cwd)) throw new Error("Worktree is cleaning up");
  }
}

export function worktreeProjectRootForManagedPath(
  cwd: string,
  worktreesBaseRoot: string,
): string | null {
  const root = resolve(worktreesBaseRoot);
  const relativePath = relative(root, resolve(cwd));
  if (!relativePath || isAbsolute(relativePath)) return null;
  const segments = relativePath.split(sep);
  if (segments.length < 2 || segments[0] === "..") return null;
  return join(root, segments[0]!);
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
