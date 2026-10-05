import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import { isPathInsideRoot } from "../utils/path.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import { resolvePaseoWorktreesBaseRoot } from "../utils/worktree.js";
import { runGitCommand } from "../utils/run-git-command.js";

const execFileAsync = promisify(execFile);
const SIZE_TTL_MS = 10 * 60_000;
const SIZE_BUDGET_MS = 1_500;
const sizeCache = new Map<string, { bytes: number; measuredAt: number }>();
const pendingSizes = new Set<string>();
let sizeQueue: Promise<void> = Promise.resolve();

export interface WorktreeStorageContext {
  paseoHome: string;
  worktreesRoot?: string;
  serverId: string;
  listWorkspaces(): Promise<PersistedWorkspaceRecord[]>;
  listAgentCwds(): string[];
  listTerminalCwds(): Promise<string[]>;
}

export interface WorktreeStorageEntry {
  entryId: string;
  name: string;
  project: string;
  path: string;
  sizeBytes: number | null;
  freeable: boolean;
  reason: string;
}

export interface WorktreeStorageList {
  entries: WorktreeStorageEntry[];
  totalBytes: number;
  freeableBytes: number;
  sizesComplete: boolean;
}

export interface WorktreeStorageCleanupResult {
  entryId: string;
  removed: boolean;
  error: string | null;
}

function entryIdForPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

async function candidatePaths(root: string): Promise<string[]> {
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const paths: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectRoot = join(root, project.name);
    for (const candidate of await readdir(projectRoot, { withFileTypes: true })) {
      if (candidate.isDirectory()) paths.push(join(projectRoot, candidate.name));
    }
  }
  return paths.sort();
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function countLines(output: string): number {
  return output.trim() ? output.trimEnd().split("\n").length : 0;
}

function cachedSize(path: string): number | null {
  const cached = sizeCache.get(path);
  if (!cached) return null;
  if (Date.now() - cached.measuredAt < SIZE_TTL_MS) return cached.bytes;
  sizeCache.delete(path);
  return null;
}

function scheduleSize(path: string): void {
  if (cachedSize(path) !== null || pendingSizes.has(path)) return;
  pendingSizes.add(path);
  sizeQueue = measureSizeAfter(sizeQueue, path);
}

async function portableDirectoryBytes(root: string): Promise<number> {
  const pending = [root];
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    const stats = await lstat(current);
    if (stats.isDirectory()) {
      const children = await readdir(current);
      for (const child of children) pending.push(join(current, child));
    } else {
      bytes += stats.size;
    }
  }
  return bytes;
}

async function measureSizeAfter(previous: Promise<void>, path: string): Promise<void> {
  await previous;
  try {
    let bytes: number;
    if (process.platform === "win32") {
      bytes = await portableDirectoryBytes(path);
    } else {
      const { stdout } = await execFileAsync("du", ["-sk", path], { timeout: 30_000 });
      bytes = Number(stdout.trim().split(/\s+/)[0]) * 1024;
    }
    if (Number.isSafeInteger(bytes) && bytes >= 0) {
      sizeCache.set(path, { bytes, measuredAt: Date.now() });
    }
  } catch {
    // A failed measurement leaves deletion eligibility unchanged.
  } finally {
    pendingSizes.delete(path);
  }
}

function referencesPath(workspace: PersistedWorkspaceRecord, path: string): boolean {
  return (
    isPathInsideRoot(path, workspace.cwd) ||
    (workspace.worktreeRoot !== null && isPathInsideRoot(path, workspace.worktreeRoot))
  );
}

async function inspectGitWorktree(
  path: string,
): Promise<{ mainRepo: string; changes: number; unpushed: number } | null> {
  if (!(await lstat(join(path, ".git"))).isFile()) return null;
  const top = (await runGitCommand(["rev-parse", "--show-toplevel"], { cwd: path })).stdout.trim();
  const canonicalPath = await realpath(path);
  if ((await realpath(top)) !== canonicalPath) return null;
  const listed = (await runGitCommand(["worktree", "list", "--porcelain"], { cwd: path })).stdout;
  const registrations = listed.split("\n").filter((line) => line.startsWith("worktree "));
  let isRegistered = false;
  for (const line of registrations) {
    try {
      if ((await realpath(line.slice(9))) === canonicalPath) {
        isRegistered = true;
        break;
      }
    } catch {
      // Other worktree registrations may point at deleted directories.
    }
  }
  if (!isRegistered) return null;
  const mainRepo = registrations[0]?.slice(9);
  if (!mainRepo || (await realpath(mainRepo)) === canonicalPath) return null;
  const status = (await runGitCommand(["status", "--porcelain", "-unormal"], { cwd: path })).stdout;
  const changes = countLines(status);
  const commits = (
    await runGitCommand(["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: path })
  ).stdout;
  const unpushed = Number(commits.trim());
  if (!Number.isSafeInteger(unpushed)) return null;
  return { mainRepo, changes, unpushed };
}

async function classify(
  path: string,
  context: WorktreeStorageContext,
  workspaces: PersistedWorkspaceRecord[],
  agentCwds: string[],
  terminalCwds: string[],
): Promise<{ freeable: boolean; reason: string; mainRepo: string | null }> {
  const keep = (reason: string) => ({ freeable: false, reason, mainRepo: null });
  try {
    const metadata = readPaseoWorktreeMetadata(path);
    if (metadata?.version === 2 && metadata.owner?.serverId !== undefined) {
      if (metadata.owner.serverId !== context.serverId) return keep("used by another Paseo host");
    }
    if (workspaces.some((workspace) => !workspace.archivedAt && referencesPath(workspace, path))) {
      return keep("used by an active workspace");
    }
    if ([...agentCwds, ...terminalCwds].some((cwd) => isPathInsideRoot(path, cwd))) {
      return keep("used by a live agent or terminal");
    }
    const git = await inspectGitWorktree(path);
    if (!git) return keep("not a git worktree");
    const { changes, unpushed, mainRepo } = git;
    if (changes) return keep(`${changes} uncommitted ${changes === 1 ? "change" : "changes"}`);
    if (unpushed) return keep(`${unpushed} unpushed ${unpushed === 1 ? "commit" : "commits"}`);
    const archived = workspaces.some(
      (workspace) => workspace.archivedAt && referencesPath(workspace, path),
    );
    return { freeable: true, reason: archived ? "archived" : "not a workspace", mainRepo };
  } catch {
    return keep("not a git worktree");
  }
}

async function snapshot(context: WorktreeStorageContext) {
  const root = resolvePaseoWorktreesBaseRoot(context);
  const [paths, workspaces, terminalCwds] = await Promise.all([
    candidatePaths(root),
    context.listWorkspaces(),
    context.listTerminalCwds(),
  ]);
  return { paths, workspaces, terminalCwds, agentCwds: context.listAgentCwds() };
}

export async function listWorktreeStorage(
  context: WorktreeStorageContext,
): Promise<WorktreeStorageList> {
  const state = await snapshot(context);
  const entries: WorktreeStorageEntry[] = [];
  for (const path of state.paths) {
    const classification = await classify(
      path,
      context,
      state.workspaces,
      state.agentCwds,
      state.terminalCwds,
    );
    entries.push({
      entryId: entryIdForPath(path),
      name: basename(path),
      project: classification.mainRepo ? basename(classification.mainRepo) : "",
      path,
      sizeBytes: null,
      freeable: classification.freeable,
      reason: classification.reason,
    });
  }
  let needsMeasurement = false;
  for (const entry of entries) {
    if (cachedSize(entry.path) === null) {
      needsMeasurement = true;
      scheduleSize(entry.path);
    }
  }
  if (needsMeasurement) {
    await Promise.race([sizeQueue, new Promise<void>((done) => setTimeout(done, SIZE_BUDGET_MS))]);
  }
  for (const entry of entries) entry.sizeBytes = cachedSize(entry.path);
  return {
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    freeableBytes: entries.reduce(
      (sum, entry) => sum + (entry.freeable ? (entry.sizeBytes ?? 0) : 0),
      0,
    ),
    sizesComplete: entries.every((entry) => entry.sizeBytes !== null),
  };
}

export async function cleanupWorktreeStorage(
  context: WorktreeStorageContext,
  entryIds: string[],
): Promise<WorktreeStorageCleanupResult[]> {
  const results: WorktreeStorageCleanupResult[] = [];
  const pruned = new Set<string>();
  for (const entryId of new Set(entryIds)) {
    const state = await snapshot(context);
    const path = state.paths.find((candidate) => entryIdForPath(candidate) === entryId);
    if (!path) {
      results.push({ entryId, removed: false, error: "Worktree is no longer available" });
      continue;
    }
    const classification = await classify(
      path,
      context,
      state.workspaces,
      state.agentCwds,
      state.terminalCwds,
    );
    if (!classification.freeable || !classification.mainRepo) {
      results.push({ entryId, removed: false, error: classification.reason });
      continue;
    }
    try {
      await runGitCommand(["worktree", "remove", path], {
        cwd: classification.mainRepo,
        timeout: 120_000,
      });
      sizeCache.delete(path);
      pruned.add(classification.mainRepo);
      try {
        await rmdir(dirname(path));
      } catch {
        /* A nonempty or inaccessible parent does not undo git's successful removal. */
      }
      results.push({ entryId, removed: true, error: null });
    } catch (error) {
      results.push({
        entryId,
        removed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const mainRepo of pruned) {
    try {
      await runGitCommand(["worktree", "prune"], { cwd: mainRepo, timeout: 30_000 });
    } catch {
      // Removal already succeeded; a future git operation can prune registrations.
    }
  }
  return results;
}
