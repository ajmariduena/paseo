import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import { areEquivalentPaths, isPathInsideRoot } from "../utils/path.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import { resolvePaseoWorktreesBaseRoot, runWorktreeTeardownCommands } from "../utils/worktree.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { withWorktreeCleanupReservation, withWorktreeProjectLock } from "./worktree-use-lock.js";
import type { HandoffMutationScope, HandoffOwnership } from "./handoff/ownership.js";

const execFileAsync = promisify(execFile);
const SIZE_TTL_MS = 10 * 60_000;
const SIZE_BUDGET_MS = 1_500;
const PROCESS_CHECK_TIMEOUT_MS = 10_000;
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
  readProcessCwds?: () => Promise<ProcessCwdReading>;
  processProbeNow?: () => number;
  processCheckTimeoutMs?: number;
  handoffOwnership?: HandoffOwnership;
}

export interface WorktreeStorageEntry {
  entryId: string;
  name: string;
  project: string;
  path: string;
  sizeBytes: number | null;
  freeable: boolean;
  requiresExplicitOptIn: boolean;
  reason: string;
}

export interface WorktreeStorageList {
  entries: WorktreeStorageEntry[];
  totalBytes: number;
  freeableBytes: number;
  sizesComplete: boolean;
  processCheckUnavailableReason: "lsof_missing" | "check_failed" | null;
}

export interface WorktreeStorageCleanupResult {
  entryId: string;
  removed: boolean;
  error: string | null;
}

export interface AutomaticWorktreeCleanupResult {
  scanned: number;
  candidates: number;
  removed: number;
  removedPaths: string[];
  failures: Array<{ path: string; error: string }>;
}

interface StorageMutationInput {
  context: WorktreeStorageContext;
  paths: string[];
  mainRepo: string;
  workspaces: PersistedWorkspaceRecord[];
}

async function acquireStorageMutation(input: StorageMutationInput): Promise<() => void> {
  const ownership = input.context.handoffOwnership;
  if (!ownership) return () => undefined;
  const scopes: HandoffMutationScope[] = [{ cwd: input.mainRepo }];
  for (const path of input.paths) scopes.push({ cwd: path });
  for (const workspace of input.workspaces) {
    if (!input.paths.some((path) => referencesPath(workspace, path))) continue;
    scopes.push({ cwd: workspace.cwd, workspaceId: workspace.workspaceId });
    if (workspace.worktreeRoot) scopes.push({ cwd: workspace.worktreeRoot });
    if (workspace.mainRepoRoot) scopes.push({ cwd: workspace.mainRepoRoot });
  }
  const releases: Array<() => void> = [];
  try {
    for (const scope of scopes) releases.push(await ownership.acquireMutation(scope));
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
  return () => {
    for (const release of releases) release();
  };
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
): Promise<{ mainRepo: string; changes: number; unpushed: number; detached: boolean } | null> {
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
  const status = (
    await runGitCommand(["status", "--porcelain", "-unormal"], {
      cwd: path,
      envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
    })
  ).stdout;
  const changes = countLines(status);
  const branch = (await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path })).stdout;
  const commits = (
    await runGitCommand(["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: path })
  ).stdout;
  const unpushed = Number(commits.trim());
  if (!Number.isSafeInteger(unpushed)) return null;
  return { mainRepo, changes, unpushed, detached: branch.trim() === "HEAD" };
}

interface ProcessCwdReading {
  cwds: string[] | null;
  unavailableReason: "lsof_missing" | "check_failed" | null;
}

async function listExternalProcessCwds(): Promise<ProcessCwdReading> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { cwds: null, unavailableReason: "check_failed" };
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-n", "-w", "-a", "-d", "cwd", "-F", "n"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      cwds: stdout
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1)),
      unavailableReason: null,
    };
  } catch (error) {
    return {
      cwds: null,
      unavailableReason:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "lsof_missing"
          : "check_failed",
    };
  }
}

function createProcessCwdProbe(
  readCwds: () => Promise<ProcessCwdReading> = listExternalProcessCwds,
  now: () => number = Date.now,
  timeoutMs = PROCESS_CHECK_TIMEOUT_MS,
) {
  let last: ProcessCwdReading | null = null;
  let measuredAt = 0;
  let pending: Promise<ProcessCwdReading> | null = null;
  const unavailable = (): ProcessCwdReading => ({ cwds: null, unavailableReason: "check_failed" });
  async function load(forceFresh: boolean): Promise<ProcessCwdReading> {
    if (!forceFresh && last && now() - measuredAt < 1_000) return last;
    if (pending) {
      if (forceFresh) {
        await pending;
        return load(true);
      }
      return pending;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    pending = Promise.race([
      Promise.resolve().then(readCwds).catch(unavailable),
      new Promise<ProcessCwdReading>((done) => {
        timeout = setTimeout(() => done(unavailable()), timeoutMs);
      }),
    ]);
    try {
      last = await pending;
      measuredAt = now();
      return last;
    } finally {
      if (timeout) clearTimeout(timeout);
      pending = null;
    }
  }
  const read = () => load(false);
  read.fresh = () => load(true);
  return read;
}

async function externalProcessCwdStatus(
  path: string,
  knownCwds: string[] | null,
): Promise<"clear" | "busy" | "unknown"> {
  if (knownCwds === null) return "unknown";
  try {
    const canonicalPath = await realpath(path);
    return knownCwds.some((cwd) => isPathInsideRoot(canonicalPath, cwd)) ? "busy" : "clear";
  } catch {
    return "unknown";
  }
}

async function classify(
  path: string,
  context: WorktreeStorageContext,
  workspaces: PersistedWorkspaceRecord[],
  agentCwds: string[],
  terminalCwds: string[],
  processCwds: string[] | null,
): Promise<{
  freeable: boolean;
  requiresExplicitOptIn: boolean;
  reason: string;
  mainRepo: string | null;
}> {
  const keep = (reason: string) => ({
    freeable: false,
    requiresExplicitOptIn: false,
    reason,
    mainRepo: null,
  });
  try {
    const metadata = readPaseoWorktreeMetadata(path);
    const ownerless = metadata?.version !== 2 || !metadata.owner?.serverId;
    if (metadata?.version === 2 && metadata.owner?.serverId !== undefined) {
      const foreignServer = metadata.owner.serverId !== context.serverId;
      const foreignHome =
        metadata.owner.paseoHome !== undefined &&
        resolve(metadata.owner.paseoHome) !== resolve(context.paseoHome);
      if (foreignServer || foreignHome) return keep("used by another Paseo host");
    }
    if (workspaces.some((workspace) => !workspace.archivedAt && referencesPath(workspace, path))) {
      return keep("used by an active workspace");
    }
    if ([...agentCwds, ...terminalCwds].some((cwd) => isPathInsideRoot(path, cwd))) {
      return keep("used by a live agent or terminal");
    }
    const processStatus = await externalProcessCwdStatus(path, processCwds);
    if (processStatus === "unknown") return keep("Could not check running processes");
    if (processStatus === "busy") return keep("used by a running process");
    const git = await inspectGitWorktree(path);
    if (!git) return keep("not a git worktree");
    return classifyGitState(path, workspaces, git, ownerless);
  } catch {
    return keep("not a git worktree");
  }
}

function classifyGitState(
  path: string,
  workspaces: PersistedWorkspaceRecord[],
  git: NonNullable<Awaited<ReturnType<typeof inspectGitWorktree>>>,
  ownerless: boolean,
) {
  const { changes, unpushed, mainRepo, detached } = git;
  const keep = (reason: string) => ({
    freeable: false,
    requiresExplicitOptIn: false,
    reason,
    mainRepo: null,
  });
  if (detached) return keep("Detached HEAD");
  if (changes) return keep(`${changes} uncommitted ${changes === 1 ? "change" : "changes"}`);
  if (unpushed) return keep(`${unpushed} unpushed ${unpushed === 1 ? "commit" : "commits"}`);
  if (ownerless) {
    return {
      freeable: false,
      requiresExplicitOptIn: true,
      reason: "Created before ownership tracking",
      mainRepo,
    };
  }
  const archived = workspaces.some(
    (workspace) => workspace.archivedAt && referencesPath(workspace, path),
  );
  return {
    freeable: true,
    requiresExplicitOptIn: false,
    reason: archived ? "archived" : "not a workspace",
    mainRepo,
  };
}

async function snapshot(
  context: WorktreeStorageContext,
  processProbe: () => Promise<ProcessCwdReading>,
) {
  const root = resolvePaseoWorktreesBaseRoot(context);
  const [paths, workspaces, terminalCwds, processReading] = await Promise.all([
    candidatePaths(root),
    context.listWorkspaces(),
    context.listTerminalCwds(),
    processProbe(),
  ]);
  return { paths, workspaces, terminalCwds, processReading, agentCwds: context.listAgentCwds() };
}

async function liveUse(
  context: WorktreeStorageContext,
  processProbe: ReturnType<typeof createProcessCwdProbe>,
) {
  const [workspaces, terminalCwds, processReading] = await Promise.all([
    context.listWorkspaces(),
    context.listTerminalCwds(),
    processProbe(),
  ]);
  return { workspaces, terminalCwds, processReading, agentCwds: context.listAgentCwds() };
}

async function freshExternalProcessCwdStatus(
  path: string,
  processProbe: ReturnType<typeof createProcessCwdProbe>,
): Promise<"clear" | "busy" | "unknown"> {
  const reading = await processProbe.fresh();
  return externalProcessCwdStatus(path, reading.cwds);
}

export async function listWorktreeStorage(
  context: WorktreeStorageContext,
): Promise<WorktreeStorageList> {
  const state = await snapshot(
    context,
    createProcessCwdProbe(
      context.readProcessCwds,
      context.processProbeNow,
      context.processCheckTimeoutMs,
    ),
  );
  const entries: WorktreeStorageEntry[] = [];
  for (const path of state.paths) {
    const classification = await classify(
      path,
      context,
      state.workspaces,
      state.agentCwds,
      state.terminalCwds,
      state.processReading.cwds,
    );
    entries.push({
      entryId: entryIdForPath(path),
      name: basename(path),
      project: classification.mainRepo ? basename(classification.mainRepo) : "",
      path,
      sizeBytes: null,
      freeable: classification.freeable,
      requiresExplicitOptIn: classification.requiresExplicitOptIn,
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
    processCheckUnavailableReason: state.processReading.unavailableReason,
  };
}

export async function cleanupWorktreeStorage(
  context: WorktreeStorageContext,
  entryIds: string[],
  legacyEntryIds: string[] = [],
): Promise<WorktreeStorageCleanupResult[]> {
  const results: WorktreeStorageCleanupResult[] = [];
  const pruned = new Set<string>();
  const processProbe = createProcessCwdProbe(
    context.readProcessCwds,
    context.processProbeNow,
    context.processCheckTimeoutMs,
  );
  const state = await snapshot(context, processProbe);
  const legacyConsent = new Set(legacyEntryIds);
  for (const entryId of new Set(entryIds)) {
    const path = state.paths.find((candidate) => entryIdForPath(candidate) === entryId);
    if (!path) {
      results.push({ entryId, removed: false, error: "Worktree is no longer available" });
      continue;
    }
    let release: () => void = () => undefined;
    try {
      await withWorktreeCleanupReservation(path, async () => {
        const beforeTeardown = await liveUse(context, processProbe);
        const beforeClassification = await classify(
          path,
          context,
          beforeTeardown.workspaces,
          beforeTeardown.agentCwds,
          beforeTeardown.terminalCwds,
          beforeTeardown.processReading.cwds,
        );
        if (
          !beforeClassification.freeable &&
          !(beforeClassification.requiresExplicitOptIn && legacyConsent.has(entryId))
        )
          throw new Error(beforeClassification.reason);
        if (!beforeClassification.mainRepo) throw new Error(beforeClassification.reason);
        const admittedRepo = beforeClassification.mainRepo;
        release = await acquireStorageMutation({
          context,
          paths: [path],
          mainRepo: admittedRepo,
          workspaces: beforeTeardown.workspaces,
        });
        const archived = beforeTeardown.workspaces.filter(
          (workspace) => workspace.archivedAt && referencesPath(workspace, path),
        );
        const teardownCwds =
          archived.length > 0
            ? new Set(archived.map((workspace) => workspace.cwd))
            : new Set([path]);
        for (const cwd of teardownCwds) {
          await runWorktreeTeardownCommands({
            worktreePath: path,
            teardownCwd: cwd,
            repoRootPath: beforeClassification.mainRepo,
          });
        }
        await withWorktreeProjectLock(dirname(path), async () => {
          const fresh = await liveUse(context, processProbe);
          const classification = await classify(
            path,
            context,
            fresh.workspaces,
            fresh.agentCwds,
            fresh.terminalCwds,
            fresh.processReading.cwds,
          );
          if (
            !classification.freeable &&
            !(classification.requiresExplicitOptIn && legacyConsent.has(entryId))
          )
            throw new Error(classification.reason);
          if (!classification.mainRepo) throw new Error(classification.reason);
          if (!areEquivalentPaths(classification.mainRepo, admittedRepo)) {
            throw new Error("Worktree repository changed during cleanup");
          }
          const processStatus = await freshExternalProcessCwdStatus(path, processProbe);
          if (processStatus === "unknown") throw new Error("Could not check running processes");
          if (processStatus === "busy") throw new Error("used by a running process");
          await removeWorktree(path, classification.mainRepo);
          pruned.add(classification.mainRepo);
        });
      });
      results.push({ entryId, removed: true, error: null });
    } catch (error) {
      results.push({
        entryId,
        removed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      release();
    }
  }
  await pruneRepos(pruned, context);
  return results;
}

async function removeWorktree(path: string, mainRepo: string): Promise<void> {
  await runGitCommand(["worktree", "remove", path], { cwd: mainRepo, timeout: 120_000 });
  sizeCache.delete(path);
  try {
    await rmdir(dirname(path));
  } catch {
    // A nonempty or inaccessible parent does not undo Git's successful removal.
  }
}

async function pruneRepos(repos: Set<string>, context: WorktreeStorageContext): Promise<void> {
  for (const mainRepo of repos) {
    let release: () => void = () => undefined;
    try {
      // Prune changes registrations for every worktree, including ones outside
      // managed storage. Admit all of them; a frozen stale entry must survive.
      const listed = await runGitCommand(["worktree", "list", "--porcelain", "-z"], {
        cwd: mainRepo,
      });
      if (listed.truncated) throw new Error("Incomplete worktree inventory");
      const paths = listed.stdout
        .split("\0")
        .filter((field) => field.startsWith("worktree "))
        .map((field) => field.slice(9));
      release = await acquireStorageMutation({
        context,
        paths,
        mainRepo,
        workspaces: await context.listWorkspaces(),
      });
      await runGitCommand(["worktree", "prune"], { cwd: mainRepo, timeout: 30_000 });
    } catch {
      // Removal already succeeded; a future git operation can prune registrations.
    } finally {
      release();
    }
  }
}

function archivedOwnedRecords(
  path: string,
  context: WorktreeStorageContext,
  workspaces: PersistedWorkspaceRecord[],
): PersistedWorkspaceRecord[] {
  try {
    const metadata = readPaseoWorktreeMetadata(path);
    if (
      metadata?.version !== 2 ||
      metadata.owner?.serverId !== context.serverId ||
      metadata.owner.paseoHome === undefined ||
      resolve(metadata.owner.paseoHome) !== resolve(context.paseoHome)
    )
      return [];
  } catch {
    return [];
  }
  const linked = workspaces.filter((workspace) => referencesPath(workspace, path));
  if (linked.length === 0 || linked.some((workspace) => !workspace.archivedAt)) return [];
  return linked;
}

export async function sweepOwnedArchivedWorktrees(
  context: WorktreeStorageContext,
  isEnabled: () => boolean,
): Promise<AutomaticWorktreeCleanupResult> {
  const processProbe = createProcessCwdProbe(
    context.readProcessCwds,
    context.processProbeNow,
    context.processCheckTimeoutMs,
  );
  const initial = await snapshot(context, processProbe);
  const result: AutomaticWorktreeCleanupResult = {
    scanned: 0,
    candidates: 0,
    removed: 0,
    removedPaths: [],
    failures: [],
  };
  const pruned = new Set<string>();
  for (const path of initial.paths) {
    if (!isEnabled()) break;
    result.scanned += 1;
    const linked = archivedOwnedRecords(path, context, initial.workspaces);
    if (linked.length === 0) continue;
    const initialClassification = await classify(
      path,
      context,
      initial.workspaces,
      initial.agentCwds,
      initial.terminalCwds,
      initial.processReading.cwds,
    );
    if (!initialClassification.freeable || !initialClassification.mainRepo) continue;
    result.candidates += 1;
    let release: () => void = () => undefined;
    try {
      await withWorktreeCleanupReservation(path, async () => {
        if (!isEnabled()) return;
        const beforeTeardown = await liveUse(context, processProbe);
        const currentRecords = archivedOwnedRecords(path, context, beforeTeardown.workspaces);
        if (currentRecords.length === 0) return;
        const beforeClassification = await classify(
          path,
          context,
          beforeTeardown.workspaces,
          beforeTeardown.agentCwds,
          beforeTeardown.terminalCwds,
          beforeTeardown.processReading.cwds,
        );
        if (!beforeClassification.freeable || !beforeClassification.mainRepo) return;
        const admittedRepo = beforeClassification.mainRepo;
        release = await acquireStorageMutation({
          context,
          paths: [path],
          mainRepo: admittedRepo,
          workspaces: beforeTeardown.workspaces,
        });
        for (const cwd of new Set(currentRecords.map((workspace) => workspace.cwd))) {
          await runWorktreeTeardownCommands({
            worktreePath: path,
            teardownCwd: cwd,
            repoRootPath: beforeClassification.mainRepo,
          });
        }
        if (!isEnabled()) return;
        await withWorktreeProjectLock(dirname(path), async () => {
          if (!isEnabled()) return;
          const fresh = await liveUse(context, processProbe);
          if (archivedOwnedRecords(path, context, fresh.workspaces).length === 0) return;
          const classification = await classify(
            path,
            context,
            fresh.workspaces,
            fresh.agentCwds,
            fresh.terminalCwds,
            fresh.processReading.cwds,
          );
          if (!classification.freeable || !classification.mainRepo || !isEnabled()) return;
          if (!areEquivalentPaths(classification.mainRepo, admittedRepo)) {
            throw new Error("Worktree repository changed during cleanup");
          }
          if ((await freshExternalProcessCwdStatus(path, processProbe)) !== "clear") return;
          if (!isEnabled()) return;
          await removeWorktree(path, classification.mainRepo);
          pruned.add(classification.mainRepo);
          result.removed += 1;
          result.removedPaths.push(path);
        });
      });
    } catch (error) {
      result.failures.push({ path, error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
    await delay(250);
  }
  await pruneRepos(pruned, context);
  return result;
}
