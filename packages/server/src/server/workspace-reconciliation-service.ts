import { statSync, watch as watchPath } from "node:fs";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type pino from "pino";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { areEquivalentPaths } from "../utils/path.js";
import {
  deriveProjectKind,
  reconcileWorkspacePlacement,
  type MutableWorkspacePlacement,
} from "./workspace-registry-model.js";
import { workspaceIdsForProjects } from "./workspace-directory.js";
import { deriveProjectKey } from "./project-key.js";
import {
  HandoffOwnershipError,
  type HandoffMutationScope,
  type HandoffOwnership,
} from "./handoff/ownership.js";

const DEFAULT_RESCAN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 100;

export type ProjectUpdate =
  | { kind: "upsert"; project: PersistedProjectRecord }
  | { kind: "remove"; projectId: string };

interface ProjectRootWatcher {
  close(): void;
}

export interface ProjectRootWatch {
  (
    rootPath: string,
    options: { recursive: false },
    onChange: (event: string, filename: string | Buffer | null) => void,
    onError: (error: Error) => void,
  ): ProjectRootWatcher;
}

export interface ReconciliationTimer {
  unref?(): void;
}

export interface ReconciliationClock {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): ReconciliationTimer;
  clearTimeout(timer: ReconciliationTimer): void;
  setInterval(callback: () => void | Promise<void>, delayMs: number): ReconciliationTimer;
  clearInterval(timer: ReconciliationTimer): void;
}

const systemClock: ReconciliationClock = {
  setTimeout: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(() => void callback(), delayMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

/**
 * The scratch parent lives inside PASEO_HOME and never holds a checkout. Watching it would also
 * lock the directory on Windows, so removing the home fails with EBUSY.
 */
function isReconciledProject(project: PersistedProjectRecord): boolean {
  return project.origin !== "scratch";
}

const watchProjectRoot: ProjectRootWatch = (rootPath, options, onChange, onError) => {
  const watcher = watchPath(rootPath, options, onChange);
  watcher.on("error", onError);
  return watcher;
};

export type ReconciliationChange =
  | { kind: "workspace_archived"; workspaceId: string; directory: string; reason: string }
  | {
      kind: "project_updated";
      projectId: string;
      directory: string;
      fields: Partial<Pick<PersistedProjectRecord, "kind" | "projectKey">>;
    }
  | {
      kind: "workspace_updated";
      workspaceId: string;
      directory: string;
      fields: Partial<MutableWorkspacePlacement>;
    };

export interface ReconciliationResult {
  changesApplied: ReconciliationChange[];
  durationMs: number;
}

export interface WorkspaceReconciliationServiceOptions {
  serverId?: string;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: pino.Logger;
  onChanges?: (changes: ReconciliationChange[]) => void;
  workspaceGitService?: Pick<WorkspaceGitService, "getCheckout">;
  onProjectUpdate?: (update: ProjectUpdate) => void;
  onWorkspaceArchived?: (workspaceId: string) => void | Promise<void>;
  onWorkspacesChanged?: (workspaceIds: string[]) => Promise<void>;
  watchProjectRoot?: ProjectRootWatch;
  clock?: ReconciliationClock;
  rescanIntervalMs?: number;
  debounceMs?: number;
  handoffOwnership?: HandoffOwnership;
}

interface ProjectReconciliationInput {
  project: PersistedProjectRecord;
  siblings: PersistedWorkspaceRecord[];
  currentGit: ProjectCheckoutLitePayload;
  readCheckout: (cwd: string) => Promise<ProjectCheckoutLitePayload>;
  changes: ReconciliationChange[];
  releases: Array<() => void>;
}

interface CachedCheckoutRead {
  cwd: string;
  checkout: Promise<ProjectCheckoutLitePayload>;
}

interface ReconciliationPassInput {
  mode: "metadata" | "full";
  publish: boolean;
}

type DirectoryState = "directory" | "missing" | "unreadable";

export class WorkspaceReconciliationService {
  private readonly serverId: string | undefined;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly onChanges: ((changes: ReconciliationChange[]) => void) | null;
  private readonly workspaceGitService: Pick<WorkspaceGitService, "getCheckout"> | null;
  private readonly onProjectUpdate: ((update: ProjectUpdate) => void) | null;
  private readonly onWorkspaceArchived: ((workspaceId: string) => void | Promise<void>) | null;
  private readonly onWorkspacesChanged: ((workspaceIds: string[]) => Promise<void>) | null;
  private readonly watchProjectRoot: ProjectRootWatch;
  private readonly clock: ReconciliationClock;
  private readonly rescanIntervalMs: number;
  private readonly debounceMs: number;
  private readonly handoffOwnership: HandoffOwnership | undefined;
  private readonly watchers: Array<{ rootPath: string; watcher: ProjectRootWatcher }> = [];
  private unsubscribeRegistry: (() => void) | null = null;
  private rescanTimer: ReconciliationTimer | null = null;
  private debounceTimer: ReconciliationTimer | null = null;
  private disposed = false;
  private readonly pendingWork = new Set<Promise<unknown>>();
  private disposePromise: Promise<void> | null = null;
  private started = false;
  private reconciling = false;
  private reconcileQueuedMode: "metadata" | "full" | null = null;

  constructor(options: WorkspaceReconciliationServiceOptions) {
    this.serverId = options.serverId;
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "workspace-reconciliation" });
    this.onChanges = options.onChanges ?? null;
    this.workspaceGitService = options.workspaceGitService ?? null;
    this.onProjectUpdate = options.onProjectUpdate ?? null;
    this.onWorkspaceArchived = options.onWorkspaceArchived ?? null;
    this.onWorkspacesChanged = options.onWorkspacesChanged ?? null;
    this.watchProjectRoot = options.watchProjectRoot ?? watchProjectRoot;
    this.clock = options.clock ?? systemClock;
    this.rescanIntervalMs = options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.handoffOwnership = options.handoffOwnership;
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.track(() => this.startWatching());
  }

  private async startWatching(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeRegistry =
      this.projectRegistry.subscribeToMutations?.(async (mutation) => {
        try {
          // Project creation does not resolve until its root watch is installed,
          // closing the git-init race for newly added empty projects.
          await this.syncProjectRootWatches();
          if (this.disposed) return;
          if (mutation.kind === "upsert" && mutation.project && !mutation.project.archivedAt) {
            this.onProjectUpdate?.({ kind: "upsert", project: mutation.project });
          } else {
            this.onProjectUpdate?.({ kind: "remove", projectId: mutation.projectId });
          }
        } catch (error) {
          this.logger.warn({ err: error }, "Project reconciliation mutation handling failed");
        }
      }) ?? null;
    await this.syncProjectRootWatches();
    if (this.disposed) return;
    this.rescanTimer = this.clock.setInterval(
      () => this.reconcileObservedGitMetadata("full"),
      this.rescanIntervalMs,
    );
    this.rescanTimer.unref?.();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    if (this.rescanTimer) this.clock.clearInterval(this.rescanTimer);
    if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer);
    for (const { watcher } of this.watchers) watcher.close();
    this.watchers.length = 0;
    // A registry write may already be awaiting Git or disk. The caller must not
    // remove or reuse the daemon home until that write and its fanout settle.
    this.disposePromise = Promise.allSettled(this.pendingWork).then(() => undefined);
    return this.disposePromise;
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    this.pendingWork.add(pending);
    const finished = () => {
      this.pendingWork.delete(pending);
    };
    void pending.then(finished, finished);
    return pending;
  }

  /** Reconciles mutable Git facts only; never archives missing records. */
  reconcileGitMetadata(): Promise<ReconciliationResult> {
    if (this.disposed) return Promise.resolve({ changesApplied: [], durationMs: 0 });
    return this.track(() => this.runReconciliation({ mode: "metadata", publish: false }));
  }

  private async runReconciliation(input: ReconciliationPassInput): Promise<ReconciliationResult> {
    if (this.disposed) return { changesApplied: [], durationMs: 0 };
    const releases: Array<() => void> = [];
    try {
      const result =
        input.mode === "full"
          ? await this.reconcileOnce(releases)
          : await this.reconcileGitMetadataOnce(releases);
      if (input.publish) await this.publishReconciliation(result);
      return result;
    } finally {
      for (const release of releases) release();
    }
  }

  private async admitScopes(
    scopes: HandoffMutationScope[],
    releases: Array<() => void>,
  ): Promise<boolean> {
    if (!this.handoffOwnership) return true;
    const acquired: Array<() => void> = [];
    try {
      for (const scope of scopes) acquired.push(await this.handoffOwnership.acquireMutation(scope));
    } catch (error) {
      for (const release of acquired) release();
      if (error instanceof HandoffOwnershipError && error.code === "fenced") return false;
      throw error;
    }
    releases.push(...acquired);
    return true;
  }

  private async admitProjects(
    projects: PersistedProjectRecord[],
    workspaces: PersistedWorkspaceRecord[],
    releases: Array<() => void>,
  ): Promise<PersistedProjectRecord[]> {
    const scopesByProject = new Map<string, HandoffMutationScope[]>();
    for (const workspace of workspaces) {
      const scopes = scopesByProject.get(workspace.projectId) ?? [];
      scopes.push({ cwd: workspace.cwd, workspaceId: workspace.workspaceId });
      if (workspace.worktreeRoot) scopes.push({ cwd: workspace.worktreeRoot });
      if (workspace.mainRepoRoot) scopes.push({ cwd: workspace.mainRepoRoot });
      scopesByProject.set(workspace.projectId, scopes);
    }
    const admitted: PersistedProjectRecord[] = [];
    for (const project of projects) {
      if (project.archivedAt) continue;
      // Project metadata is shared by every member, including missing and archived
      // workspaces. Their identities still protect it when their paths have changed.
      const scopes = [{ cwd: project.rootPath }, ...(scopesByProject.get(project.projectId) ?? [])];
      if (await this.admitScopes(scopes, releases)) admitted.push(project);
    }
    return admitted;
  }

  private async reconcileGitMetadataOnce(
    releases: Array<() => void>,
  ): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];
    const [projects, workspaces] = await Promise.all([
      this.projectRegistry.list(),
      this.workspaceRegistry.list(),
    ]);
    const admittedProjects = await this.admitProjects(projects, workspaces, releases);
    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    for (const workspace of workspaces) {
      if (workspace.archivedAt || this.inspectDirectory(workspace.cwd) !== "directory") continue;
      const siblings = workspacesByProject.get(workspace.projectId) ?? [];
      siblings.push(workspace);
      workspacesByProject.set(workspace.projectId, siblings);
    }
    await this.reconcileGitMetadataForProjects(
      admittedProjects.filter(
        (project) => !project.archivedAt && this.inspectDirectory(project.rootPath) === "directory",
      ),
      workspacesByProject,
      changes,
      releases,
    );
    if (changes.length > 0) this.onChanges?.(changes);
    return { changesApplied: changes, durationMs: Date.now() - start };
  }

  runOnce(): Promise<ReconciliationResult> {
    if (this.disposed) return Promise.resolve({ changesApplied: [], durationMs: 0 });
    return this.track(() => this.runReconciliation({ mode: "full", publish: false }));
  }

  private async reconcileOnce(releases: Array<() => void>): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];

    const allProjects = await this.projectRegistry.list();
    const allWorkspaces = await this.workspaceRegistry.list();

    const activeProjects = await this.admitProjects(allProjects, allWorkspaces, releases);
    const activeWorkspaces = allWorkspaces.filter((w) => !w.archivedAt);
    const workspaceDirectoryStates = activeWorkspaces.map((workspace) => ({
      workspace,
      state: this.inspectDirectory(workspace.cwd),
    }));
    // Project roots are read after the workspace directories, so a volume that
    // goes away mid-pass leaves its project unreachable rather than its workspaces
    // alone. The skew can only withhold an archive, never produce one.
    const reachableProjectIds = new Set(
      activeProjects
        .filter((project) => this.inspectDirectory(project.rootPath) === "directory")
        .map((project) => project.projectId),
    );

    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    for (const { workspace, state } of workspaceDirectoryStates) {
      if (state !== "directory") continue;
      const list = workspacesByProject.get(workspace.projectId) ?? [];
      list.push(workspace);
      workspacesByProject.set(workspace.projectId, list);
    }

    // 1. Archive workspaces whose directories no longer exist, but only when the
    //    project they belong to is still reachable. A missing project root means the
    //    whole location is unavailable - an unmounted volume, an offline share, a disk
    //    that has not appeared yet - and absence there proves nothing about the
    //    workspace. Projects already persist through that; their workspaces do too.
    const missingWorkspaces = workspaceDirectoryStates
      .filter(
        ({ workspace, state }) =>
          state === "missing" && reachableProjectIds.has(workspace.projectId),
      )
      .map(({ workspace }) => workspace);
    await settleReconciliationWork(
      missingWorkspaces.map(async (workspace) => {
        const timestamp = new Date().toISOString();
        await this.workspaceRegistry.archive(workspace.workspaceId, timestamp);
        await this.onWorkspaceArchived?.(workspace.workspaceId);
        changes.push({
          kind: "workspace_archived",
          workspaceId: workspace.workspaceId,
          directory: workspace.cwd,
          reason: "directory_missing",
        });

        // Update the in-memory list for the project orphan check below
        const siblings = workspacesByProject.get(workspace.projectId);
        if (siblings) {
          const updated = siblings.filter((w) => w.workspaceId !== workspace.workspaceId);
          workspacesByProject.set(workspace.projectId, updated);
        }
      }),
    );

    // 2. Reconcile mutable git metadata without changing identity or membership.
    //    Projects persist until explicitly removed, even when they currently have
    //    zero active workspaces, so they still reconcile their own metadata.
    await this.reconcileGitMetadataForProjects(
      activeProjects.filter((project) => reachableProjectIds.has(project.projectId)),
      workspacesByProject,
      changes,
      releases,
    );

    if (changes.length > 0 && this.onChanges) {
      this.onChanges(changes);
    }

    const result = { changesApplied: changes, durationMs: Date.now() - start };
    if (changes.length > 0) {
      this.logger.info(
        { changeCount: changes.length, durationMs: result.durationMs, changes },
        "Workspace reconciliation applied changes",
      );
    }
    return result;
  }

  /** Runs the boot-time convergence path and publishes every affected workspace. */
  async reconcileNow(): Promise<void> {
    await this.reconcileObservedGitMetadata("full");
  }

  private async reconcileGitMetadataForProjects(
    projectsToReconcile: PersistedProjectRecord[],
    workspacesByProject: Map<string, PersistedWorkspaceRecord[]>,
    changes: ReconciliationChange[],
    releases: Array<() => void>,
  ): Promise<void> {
    projectsToReconcile = projectsToReconcile.filter(isReconciledProject);
    const checkoutReads: CachedCheckoutRead[] = [];
    const readCheckout = (cwd: string): Promise<ProjectCheckoutLitePayload> => {
      const existing = checkoutReads.find((read) => areEquivalentPaths(read.cwd, cwd));
      if (existing) return existing.checkout;
      const checkout = this.readCheckout(cwd);
      checkoutReads.push({ cwd, checkout });
      return checkout;
    };
    await Promise.all(
      projectsToReconcile.map(async (project) => {
        try {
          const rootGit = await readCheckout(project.rootPath);
          await this.reconcileProject({
            project,
            siblings: workspacesByProject.get(project.projectId) ?? [],
            currentGit: rootGit,
            readCheckout,
            changes,
            releases,
          });
        } catch (error) {
          this.logger.warn(
            { err: error, rootPath: project.rootPath },
            "Workspace metadata reconciliation failed",
          );
        }
      }),
    );
  }

  private async reconcileProject(input: ProjectReconciliationInput): Promise<void> {
    const { project, siblings, currentGit, readCheckout, changes, releases } = input;
    const workspaceCheckouts = await settleReconciliationWork(
      siblings.map(async (workspace) => ({
        workspace,
        checkout: await readCheckout(workspace.cwd),
      })),
    );
    // Git may reveal a backing checkout outside the persisted placement. Admit it
    // before publishing either the project or any workspace's new placement.
    const scopes: HandoffMutationScope[] = [];
    for (const checkout of [currentGit, ...workspaceCheckouts.map((entry) => entry.checkout)]) {
      if (checkout.worktreeRoot) scopes.push({ cwd: checkout.worktreeRoot });
      if (checkout.mainRepoRoot) scopes.push({ cwd: checkout.mainRepoRoot });
    }
    if (!(await this.admitScopes(scopes, releases))) return;
    const projectUpdates: Partial<Pick<PersistedProjectRecord, "kind" | "projectKey">> = {};
    const mappedKind = deriveProjectKind(currentGit);
    const projectKey = deriveProjectKey({
      rootPath: project.rootPath,
      remoteUrl: currentGit.remoteUrl,
      worktreeRoot: currentGit.worktreeRoot,
      mainRepoRoot: currentGit.mainRepoRoot,
      serverId: this.serverId,
    });

    if (project.kind !== mappedKind) {
      projectUpdates.kind = mappedKind;
    }
    if (project.projectKey !== projectKey) {
      projectUpdates.projectKey = projectKey;
    }

    if (Object.keys(projectUpdates).length > 0) {
      const timestamp = new Date().toISOString();
      await this.projectRegistry.upsert({
        ...project,
        ...projectUpdates,
        updatedAt: timestamp,
      });
      changes.push({
        kind: "project_updated",
        projectId: project.projectId,
        directory: project.rootPath,
        fields: projectUpdates,
      });
    }

    await settleReconciliationWork(
      workspaceCheckouts.map(async ({ workspace, checkout: wsGit }) => {
        const timestamp = new Date().toISOString();
        const update = reconcileWorkspacePlacement({
          workspace,
          checkout: wsGit,
          updatedAt: timestamp,
        });
        if (!update) return;

        const updated = await this.workspaceRegistry.update(workspace.workspaceId, (current) => ({
          ...current,
          ...update.fields,
          updatedAt: timestamp,
        }));
        if (!updated) return;
        changes.push({
          kind: "workspace_updated",
          workspaceId: workspace.workspaceId,
          directory: workspace.cwd,
          fields: update.fields,
        });
      }),
    );
  }

  private async syncProjectRootWatches(): Promise<void> {
    if (this.disposed) return;
    const projects = await this.projectRegistry.list();
    if (this.disposed) return;
    const activeProjects = projects.filter(
      (project) => !project.archivedAt && isReconciledProject(project),
    );

    for (let index = this.watchers.length - 1; index >= 0; index -= 1) {
      const target = this.watchers[index]!;
      const stillActive = activeProjects.some((project) =>
        areEquivalentPaths(project.rootPath, target.rootPath),
      );
      if (stillActive) continue;
      target.watcher.close();
      this.watchers.splice(index, 1);
    }

    for (const project of activeProjects) {
      const alreadyWatching = this.watchers.some((target) =>
        areEquivalentPaths(target.rootPath, project.rootPath),
      );
      if (alreadyWatching) continue;
      try {
        let watcher: ProjectRootWatcher;
        watcher = this.watchProjectRoot(
          project.rootPath,
          { recursive: false },
          (_event, filename) => {
            if (filename === null || filename.toString() === ".git") {
              this.scheduleObservedReconciliation();
            }
          },
          (error) => {
            watcher.close();
            const index = this.watchers.findIndex((target) => target.watcher === watcher);
            if (index >= 0) this.watchers.splice(index, 1);
            this.logger.warn(
              { err: error, rootPath: project.rootPath },
              "Project root watch failed",
            );
          },
        );
        this.watchers.push({ rootPath: project.rootPath, watcher });
      } catch (error) {
        // The periodic reconciliation is the convergence path for roots that
        // are temporarily missing or unwatchable.
        this.logger.debug(
          { err: error, rootPath: project.rootPath },
          "Project root is not watchable yet",
        );
      }
    }
  }

  private scheduleObservedReconciliation(): void {
    if (this.disposed || this.debounceTimer) return;
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      return this.reconcileObservedGitMetadata();
    }, this.debounceMs);
  }

  private reconcileObservedGitMetadata(mode: "metadata" | "full" = "metadata"): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.track(() => this.reconcileObserved(mode));
  }

  private async reconcileObserved(mode: "metadata" | "full"): Promise<void> {
    if (this.reconciling) {
      if (mode === "full" || this.reconcileQueuedMode === null) {
        this.reconcileQueuedMode = mode;
      }
      return;
    }
    this.reconciling = true;
    try {
      await this.syncProjectRootWatches();
      await this.runReconciliation({ mode, publish: true });
    } catch (error) {
      if (!this.disposed) {
        this.logger.warn({ err: error }, "Workspace reconciliation failed");
      }
    } finally {
      this.reconciling = false;
      if (this.reconcileQueuedMode) {
        const queuedMode = this.reconcileQueuedMode;
        this.reconcileQueuedMode = null;
        void this.reconcileObservedGitMetadata(queuedMode);
      }
    }
  }

  private async publishReconciliation(result: ReconciliationResult): Promise<void> {
    const workspaceIds = new Set<string>();
    const projectIds = new Set<string>();
    for (const change of result.changesApplied) {
      if (change.kind === "workspace_updated" || change.kind === "workspace_archived") {
        workspaceIds.add(change.workspaceId);
      }
      if (change.kind === "project_updated") projectIds.add(change.projectId);
    }
    if (projectIds.size > 0) {
      const workspaces = await this.workspaceRegistry.list();
      for (const workspaceId of workspaceIdsForProjects(workspaces, projectIds)) {
        workspaceIds.add(workspaceId);
      }
    }
    if (!this.disposed && workspaceIds.size > 0) {
      await this.onWorkspacesChanged?.(Array.from(workspaceIds));
    }
  }

  private async readCheckout(cwd: string): Promise<ProjectCheckoutLitePayload> {
    if (!this.workspaceGitService) {
      return {
        cwd,
        isGit: false as const,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false as const,
        mainRepoRoot: null,
      };
    }
    return this.workspaceGitService.getCheckout(cwd);
  }

  private inspectDirectory(targetPath: string): DirectoryState {
    try {
      return statSync(targetPath).isDirectory() ? "directory" : "missing";
    } catch (error) {
      if (isMissingPathError(error)) return "missing";
      this.logger.warn(
        { err: error, targetPath },
        "Skipped workspace reconciliation after directory inspection failed",
      );
      return "unreadable";
    }
  }
}

async function settleReconciliationWork<T>(work: Promise<T>[]): Promise<T[]> {
  // Promise.all rejects before sibling writes finish, releasing their admissions
  // while they can still change the frozen source.
  const results = await Promise.allSettled(work);
  const values: T[] = [];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") values.push(result.value);
    else failures.push(result.reason);
  }
  if (failures.length > 0) throw failures[0];
  return values;
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
