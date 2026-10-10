import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { areEquivalentPaths } from "../utils/path.js";
import { deriveProjectKey } from "./project-key.js";
import { HandoffOwnership } from "./handoff/ownership.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  type ProjectRootWatch,
  type ProjectUpdate,
  type ReconciliationClock,
  type ReconciliationTimer,
  WorkspaceReconciliationService,
} from "./workspace-reconciliation-service.js";

const TIMESTAMP = "2026-07-15T00:00:00.000Z";
const DEBOUNCE_MS = 10;
const RESCAN_INTERVAL_MS = 50;
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { recursive: true, force: true });
});

interface ProjectSpec {
  id: string;
  root: string;
  workspaces?: Array<{ id: string; cwd: string }>;
  archived?: boolean;
}

interface Gate {
  started: Promise<void>;
  release(): void;
}

function createGate(): Gate & { arrive(): Promise<void> } {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return { started, release, arrive: async () => (markStarted(), released) };
}

class ObservedProjectRegistry extends FileBackedProjectRegistry {
  private nextRead: ReturnType<typeof createGate> | null = null;

  holdNextRead(): Gate {
    return (this.nextRead = createGate());
  }

  override async list() {
    if (this.nextRead) {
      const pending = this.nextRead;
      this.nextRead = null;
      await pending.arrive();
    }
    return super.list();
  }
}

class ObservedWorkspaceRegistry extends FileBackedWorkspaceRegistry {
  private nextRead: ReturnType<typeof createGate> | null = null;
  private nextWrite: ReturnType<typeof createGate> | null = null;
  private nextError: Error | null = null;

  holdNextRead(): Gate {
    return (this.nextRead = createGate());
  }

  holdNextWrite(): Gate {
    return (this.nextWrite = createGate());
  }

  override async update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null> {
    const pending = this.nextWrite;
    this.nextWrite = null;
    await pending?.arrive();
    return super.update(workspaceId, updater);
  }

  failNextRead(error: Error): void {
    this.nextError = error;
  }

  override async list() {
    if (this.nextRead) {
      const pending = this.nextRead;
      this.nextRead = null;
      await pending.arrive();
    }
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    return super.list();
  }
}

interface TestTimer extends ReconciliationTimer {
  callback: () => void | Promise<void>;
  dueAt: number;
  intervalMs: number | null;
}

class TestClock implements ReconciliationClock {
  private now = 0;
  private readonly timers = new Set<TestTimer>();

  get pendingCount(): number {
    return this.timers.size;
  }

  setTimeout(callback: () => void | Promise<void>, delayMs: number): TestTimer {
    return this.add(callback, delayMs, null);
  }

  clearTimeout(timer: TestTimer): void {
    this.timers.delete(timer);
  }

  setInterval(callback: () => void | Promise<void>, delayMs: number): TestTimer {
    return this.add(callback, delayMs, delayMs);
  }

  clearInterval(timer: TestTimer): void {
    this.timers.delete(timer);
  }

  async advanceBy(elapsedMs: number): Promise<void> {
    const target = this.now + elapsedMs;
    for (;;) {
      const next = [...this.timers]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next) break;
      this.now = next.dueAt;
      if (next.intervalMs === null) this.timers.delete(next);
      else next.dueAt += next.intervalMs;
      await next.callback();
    }
    this.now = target;
  }

  private add(
    callback: () => void | Promise<void>,
    delayMs: number,
    intervalMs: number | null,
  ): TestTimer {
    const timer = { callback, dueAt: this.now + delayMs, intervalMs, unref: () => undefined };
    this.timers.add(timer);
    return timer;
  }
}

interface RootWatch {
  rootPath: string;
  onChange: (event: string, filename: string | Buffer | null) => void;
  onError: (error: Error) => void;
  closed: boolean;
}

/** One public behavioral seam for the complete observed-placement lifecycle. */
class ObservedPlacements {
  readonly home = mkdtempSync(path.join(tmpdir(), "observed-placement-"));
  readonly projects: ObservedProjectRegistry;
  readonly workspaces: ObservedWorkspaceRegistry;
  readonly ownership = new HandoffOwnership({
    directory: path.join(this.home, "handoff"),
    sourceServerId: "source",
  });
  private readonly clock = new TestClock();
  private readonly watches: RootWatch[] = [];
  private readonly checkoutByCwd = new Map<string, ProjectCheckoutLitePayload>();
  private readonly rootByProjectId = new Map<string, string>();
  private readonly failedWatchRoots = new Set<string>();
  private readonly projectEvents: ProjectUpdate[] = [];
  private readonly workspaceEvents: string[][] = [];
  private readonly workspaceEventWaiters: Array<() => void> = [];
  private readonly lifecycleEvents: string[] = [];
  private readonly service: WorkspaceReconciliationService;
  private started = false;
  private checkoutReadCount = 0;
  private nextPublication: ReturnType<typeof createGate> | null = null;
  readonly archivedWorkspaces: string[] = [];
  private readonly archiveGates = new Map<string, ReturnType<typeof createGate>>();
  private readonly archiveFailures = new Set<string>();

  constructor(private readonly specs: ProjectSpec[]) {
    cleanupPaths.push(this.home);
    const logger = createTestLogger();
    this.projects = new ObservedProjectRegistry(path.join(this.home, "projects.json"), logger);
    this.workspaces = new ObservedWorkspaceRegistry(
      path.join(this.home, "workspaces.json"),
      logger,
    );
    const watchProjectRoot: ProjectRootWatch = (rootPath, _options, onChange, onError) => {
      if (this.failedWatchRoots.delete(rootPath)) throw new Error("root unavailable");
      const watch = { rootPath, onChange, onError, closed: false };
      this.watches.push(watch);
      this.lifecycleEvents.push(`watch installed:${path.relative(this.home, rootPath)}`);
      return { close: () => (watch.closed = true) };
    };
    this.service = new WorkspaceReconciliationService({
      handoffOwnership: this.ownership,
      projectRegistry: this.projects,
      workspaceRegistry: this.workspaces,
      workspaceGitService: { getCheckout: async (cwd) => this.readCheckout(cwd) },
      logger,
      watchProjectRoot,
      clock: this.clock,
      debounceMs: DEBOUNCE_MS,
      rescanIntervalMs: RESCAN_INTERVAL_MS,
      onProjectUpdate: (update) => {
        this.projectEvents.push(update);
        this.lifecycleEvents.push(
          update.kind === "upsert"
            ? `project published:upsert:${update.project.projectId}`
            : `project published:remove:${update.projectId}`,
        );
      },
      onWorkspacesChanged: async (workspaceIds) => {
        const pending = this.nextPublication;
        this.nextPublication = null;
        await pending?.arrive();
        this.workspaceEvents.push(workspaceIds);
        this.workspaceEventWaiters.shift()?.();
      },
      onWorkspaceArchived: async (workspaceId) => {
        this.archivedWorkspaces.push(workspaceId);
        await this.archiveGates.get(workspaceId)?.arrive();
        if (this.archiveFailures.has(workspaceId)) throw new Error("Runtime cleanup failed");
      },
    });
  }

  async start(): Promise<void> {
    if (!this.started) {
      await this.ownership.initialize();
      for (const spec of this.specs) await this.seed(spec);
      this.started = true;
    }
    await this.service.start();
  }

  async add(spec: ProjectSpec): Promise<void> {
    await this.seed(spec);
    this.lifecycleEvents.push(`registry mutation resolved:${spec.id}`);
  }

  async archive(projectId: string): Promise<void> {
    await this.projects.archive(projectId, TIMESTAMP);
  }

  async remove(projectId: string): Promise<void> {
    await this.projects.remove(projectId);
  }

  failNextWatch(root: string): void {
    this.failedWatchRoots.add(this.absolute(root));
  }

  watcherFailed(root: string): void {
    this.activeWatch(root)?.onError(new Error("watch failed"));
  }

  change(root: string, filename: string | null): void {
    this.activeWatch(root)?.onChange("rename", filename);
  }

  makeProjectGit(projectId: string, branch = "main"): void {
    const rootPath = this.rootByProjectId.get(projectId);
    if (!rootPath) throw new Error(`Unknown project: ${projectId}`);
    this.checkoutByCwd.set(rootPath, {
      cwd: rootPath,
      isGit: true,
      currentBranch: branch,
      remoteUrl: null,
      worktreeRoot: rootPath,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    });
  }

  failNextReconciliation(error: Error): void {
    this.workspaces.failNextRead(error);
  }

  holdNextRegistryRead(): Gate {
    return this.projects.holdNextRead();
  }

  holdNextReconciliation(): Gate {
    return this.workspaces.holdNextRead();
  }

  holdNextPublication(): Gate {
    return (this.nextPublication = createGate());
  }

  holdArchive(workspaceId: string): Gate {
    const pending = createGate();
    this.archiveGates.set(workspaceId, pending);
    return pending;
  }

  failArchive(workspaceId: string): void {
    this.archiveFailures.add(workspaceId);
  }

  async prepareHandoff(input: { cwd: string; workspaceId: string }): Promise<string> {
    const cwd = path.join(this.home, input.cwd);
    mkdirSync(cwd, { recursive: true });
    const id = randomUUID();
    await this.ownership.prepare({
      id,
      cwd,
      workspaceId: input.workspaceId,
      agentIds: [],
      destinationServerId: "target",
      reservationId: randomUUID(),
    });
    return id;
  }

  async advanceBy(elapsedMs: number): Promise<void> {
    await this.clock.advanceBy(elapsedMs);
  }

  dispose() {
    return this.service.dispose();
  }

  watchedRoots(): string[] {
    return this.watches
      .filter((watch) => !watch.closed)
      .map((watch) => path.relative(this.home, watch.rootPath));
  }

  closedRoots(): string[] {
    return this.watches
      .filter((watch) => watch.closed)
      .map((watch) => path.relative(this.home, watch.rootPath));
  }

  async placement(workspaceId: string): Promise<PersistedWorkspaceRecord | null> {
    return this.workspaces.get(workspaceId);
  }

  async deleteWorkspaceDirectory(workspaceId: string): Promise<void> {
    const workspace = await this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    rmSync(workspace.cwd, { recursive: true, force: true });
  }

  get projectUpdates(): ProjectUpdate[] {
    return [...this.projectEvents];
  }

  get workspaceBatches(): string[][] {
    return this.workspaceEvents.map((batch) => [...batch]);
  }

  waitForWorkspaceBatch(): Promise<void> {
    return new Promise((resolve) => this.workspaceEventWaiters.push(resolve));
  }

  get lifecycle(): string[] {
    return [...this.lifecycleEvents];
  }

  get gitReads(): number {
    return this.checkoutReadCount;
  }

  get pendingTimers(): number {
    return this.clock.pendingCount;
  }

  private async seed(spec: ProjectSpec): Promise<void> {
    const rootPath = this.absolute(spec.root);
    mkdirSync(rootPath, { recursive: true });
    this.rootByProjectId.set(spec.id, rootPath);
    await this.projects.upsert(
      createPersistedProjectRecord({
        projectId: spec.id,
        rootPath,
        kind: "non_git",
        // Seeded records already carry the key reconciliation derives, so a fixture's
        // first pass reports only what its test is about.
        projectKey: deriveProjectKey({
          rootPath,
          remoteUrl: null,
          worktreeRoot: null,
          mainRepoRoot: null,
        }),
        displayName: spec.id,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        archivedAt: spec.archived ? TIMESTAMP : null,
      }),
    );
    for (const workspace of spec.workspaces ?? []) {
      const cwd = this.absolute(workspace.cwd);
      mkdirSync(cwd, { recursive: true });
      await this.workspaces.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: workspace.id,
          projectId: spec.id,
          cwd,
          kind: "directory",
          displayName: `Durable ${workspace.id}`,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        }),
      );
    }
  }

  private async readCheckout(cwd: string): Promise<ProjectCheckoutLitePayload> {
    this.checkoutReadCount += 1;
    const configured = [...this.checkoutByCwd.entries()].find(([root]) =>
      areEquivalentPaths(root, cwd),
    )?.[1];
    return (
      configured ?? {
        cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }
    );
  }

  private activeWatch(root: string): RootWatch | undefined {
    const target = this.absolute(root);
    return this.watches.find(
      (watch) => !watch.closed && areEquivalentPaths(watch.rootPath, target),
    );
  }

  private absolute(relative: string): string {
    return path.join(this.home, relative);
  }
}

describe("observed workspace placement", () => {
  test("handoff preserves fenced project and workspace metadata while other projects reconcile", async () => {
    const observed = new ObservedPlacements([
      { id: "frozen", root: "source", workspaces: [{ id: "moving", cwd: "linked/src" }] },
      { id: "free", root: "free", workspaces: [{ id: "staying", cwd: "free" }] },
    ]);
    await observed.start();
    const projectBefore = await observed.projects.get("frozen");
    const workspaceBefore = await observed.placement("moving");
    observed.makeProjectGit("frozen");
    observed.makeProjectGit("free");
    const id = randomUUID();
    mkdirSync(path.join(observed.home, "different-checkout"));
    await observed.ownership.prepare({
      id,
      cwd: path.join(observed.home, "different-checkout"),
      workspaceId: "moving",
      agentIds: [],
      destinationServerId: "target",
      reservationId: randomUUID(),
    });
    try {
      observed.change("source", ".git");
      await observed.advanceBy(DEBOUNCE_MS);
      const reloadedProjects = new FileBackedProjectRegistry(
        path.join(observed.home, "projects.json"),
        createTestLogger(),
      );
      const reloadedWorkspaces = new FileBackedWorkspaceRegistry(
        path.join(observed.home, "workspaces.json"),
        createTestLogger(),
      );
      expect(await reloadedProjects.get("frozen")).toEqual(projectBefore);
      expect(await reloadedWorkspaces.get("moving")).toEqual(workspaceBefore);
      expect(await observed.placement("staying")).toMatchObject({ kind: "local_checkout" });
      expect(observed.workspaceBatches).toEqual([["staying"]]);

      await observed.ownership.cancel(id);
      observed.change("source", ".git");
      await observed.advanceBy(DEBOUNCE_MS);
      expect(await observed.projects.get("frozen")).toMatchObject({ kind: "git" });
      expect(observed.workspaceBatches).toEqual([["staying"], ["moving"]]);
    } finally {
      await observed.dispose();
    }
  });

  test.each([
    { name: "project root", fence: "source", worktreeRoot: null, mainRepoRoot: null },
    {
      name: "backing sibling",
      fence: "linked/sibling",
      worktreeRoot: "linked",
      mainRepoRoot: null,
    },
    { name: "shared repository", fence: "main", worktreeRoot: "linked", mainRepoRoot: "main" },
  ])(
    "handoff protects metadata through the $name",
    async ({ fence, worktreeRoot, mainRepoRoot }) => {
      const observed = new ObservedPlacements([
        { id: "project", root: "source", workspaces: [{ id: "moving", cwd: "linked/src" }] },
      ]);
      await observed.start();
      await observed.workspaces.update("moving", (record) => ({
        ...record,
        worktreeRoot: worktreeRoot && path.join(observed.home, worktreeRoot),
        mainRepoRoot: mainRepoRoot && path.join(observed.home, mainRepoRoot),
      }));
      const projectBefore = await observed.projects.get("project");
      const workspaceBefore = await observed.placement("moving");
      observed.makeProjectGit("project");
      const id = await observed.prepareHandoff({ cwd: fence, workspaceId: "another-workspace" });
      try {
        observed.change("source", ".git");
        await observed.advanceBy(DEBOUNCE_MS);
        expect(await observed.projects.get("project")).toEqual(projectBefore);
        expect(await observed.placement("moving")).toEqual(workspaceBefore);
        expect(observed.workspaceBatches).toEqual([]);
        // Fence a previously admitted scope to detect leases leaked by rejection
        // of a later backing/root scope, which the original fence cannot see.
        await observed.ownership.cancel(id);
        const projectTransfer = await observed.prepareHandoff({
          cwd: "source",
          workspaceId: "moving",
        });
        expect((await observed.ownership.markReady(projectTransfer, "a".repeat(64))).state).toBe(
          "ready",
        );
      } finally {
        await observed.dispose();
      }
    },
  );

  test.each([false, true])(
    "handoff protects an absent member's identity, archived=%s",
    async (archived) => {
      const observed = new ObservedPlacements([
        { id: "project", root: "source", workspaces: [{ id: "moving", cwd: "linked/src" }] },
        { id: "free", root: "free", workspaces: [{ id: "staying", cwd: "free/child" }] },
      ]);
      await observed.start();
      if (archived) await observed.workspaces.archive("moving", TIMESTAMP);
      await observed.deleteWorkspaceDirectory("moving");
      await observed.deleteWorkspaceDirectory("staying");
      observed.makeProjectGit("project");
      const projectBefore = await observed.projects.get("project");
      const workspaceBefore = await observed.placement("moving");
      const id = await observed.prepareHandoff({ cwd: "elsewhere", workspaceId: "moving" });
      try {
        await observed.advanceBy(RESCAN_INTERVAL_MS);
        expect(await observed.projects.get("project")).toEqual(projectBefore);
        expect(await observed.placement("moving")).toEqual(workspaceBefore);
        expect(observed.archivedWorkspaces).toEqual(["staying"]);
        expect(await observed.placement("staying")).toMatchObject({
          archivedAt: expect.any(String),
        });
        expect(observed.workspaceBatches).toEqual([["staying"]]);
        await observed.ownership.cancel(id);
        await observed.advanceBy(RESCAN_INTERVAL_MS);
        expect(await observed.projects.get("project")).toMatchObject({ kind: "git" });
        expect(await observed.placement("moving")).toMatchObject({
          archivedAt: expect.any(String),
        });
      } finally {
        await observed.dispose();
      }
    },
  );

  test("handoff drains admitted metadata through disk persistence and final publication", async () => {
    const observed = new ObservedPlacements([
      { id: "project", root: "source", workspaces: [{ id: "moving", cwd: "source" }] },
    ]);
    await observed.start();
    observed.makeProjectGit("project");
    const write = observed.workspaces.holdNextWrite();
    const publication = observed.holdNextPublication();
    observed.change("source", ".git");
    const advancing = observed.advanceBy(DEBOUNCE_MS);
    try {
      await write.started;
      const id = await observed.prepareHandoff({ cwd: "source", workspaceId: "moving" });
      await expect(observed.ownership.markReady(id, "a".repeat(64))).rejects.toMatchObject({
        code: "invalid_state",
      });
      write.release();
      await publication.started;
      const reloaded = new FileBackedWorkspaceRegistry(
        path.join(observed.home, "workspaces.json"),
        createTestLogger(),
      );
      expect(await reloaded.get("moving")).toMatchObject({
        kind: "local_checkout",
        branch: "main",
      });
      await expect(observed.ownership.markReady(id, "a".repeat(64))).rejects.toMatchObject({
        code: "invalid_state",
      });
      publication.release();
      await advancing;
      await observed.ownership.drain(id);
      expect((await observed.ownership.markReady(id, "a".repeat(64))).state).toBe("ready");
      expect(observed.workspaceBatches).toEqual([["moving"]]);
    } finally {
      write.release();
      publication.release();
      await advancing;
      await observed.dispose();
    }
  });

  test("handoff keeps sibling archive cleanup admitted after another cleanup fails", async () => {
    const observed = new ObservedPlacements([
      {
        id: "project",
        root: "source",
        workspaces: [
          { id: "failing", cwd: "linked/one" },
          { id: "moving", cwd: "linked/two" },
        ],
      },
    ]);
    await observed.start();
    await observed.deleteWorkspaceDirectory("failing");
    await observed.deleteWorkspaceDirectory("moving");
    observed.failArchive("failing");
    const cleanup = observed.holdArchive("moving");
    const advancing = observed.advanceBy(RESCAN_INTERVAL_MS);
    try {
      await cleanup.started;
      const id = await observed.prepareHandoff({ cwd: "elsewhere", workspaceId: "moving" });
      await expect(observed.ownership.markReady(id, "a".repeat(64))).rejects.toMatchObject({
        code: "invalid_state",
      });
      cleanup.release();
      await advancing;
      await observed.ownership.drain(id);
      expect((await observed.ownership.markReady(id, "a".repeat(64))).state).toBe("ready");
      expect(await observed.placement("moving")).toMatchObject({ archivedAt: expect.any(String) });
    } finally {
      cleanup.release();
      await advancing;
      await observed.dispose();
    }
  });

  test("installs and publishes a new project before add resolves without Git feedback", async () => {
    const observed = new ObservedPlacements([]);
    await observed.start();

    await observed.add({ id: "project-new", root: "new" });
    await observed.advanceBy(DEBOUNCE_MS);

    expect(observed.watchedRoots()).toEqual(["new"]);
    expect(observed.projectUpdates).toEqual([
      { kind: "upsert", project: expect.objectContaining({ projectId: "project-new" }) },
    ]);
    expect(observed.lifecycle).toEqual([
      "watch installed:new",
      "project published:upsert:project-new",
      "registry mutation resolved:project-new",
    ]);
    expect(observed.gitReads).toBe(0);
    observed.dispose();
  });

  test("deduplicates active root watches and tears them down on archive and remove", async () => {
    const observed = new ObservedPlacements([
      { id: "project-one", root: "repo" },
      { id: "project-duplicate", root: "repo" },
      { id: "project-remove", root: "other" },
      { id: "project-archived", root: "archived", archived: true },
    ]);

    await observed.start();
    await observed.start();
    expect(observed.watchedRoots()).toEqual(["repo", "other"]);

    await observed.archive("project-one");
    expect(observed.watchedRoots()).toEqual(["repo", "other"]);
    await observed.remove("project-duplicate");
    await observed.remove("project-remove");

    expect(observed.watchedRoots()).toEqual([]);
    expect(observed.closedRoots()).toEqual(["repo", "other"]);
    expect(observed.projectUpdates).toEqual([
      { kind: "remove", projectId: "project-one" },
      { kind: "remove", projectId: "project-duplicate" },
      { kind: "remove", projectId: "project-remove" },
    ]);
    observed.dispose();
  });

  test("filters unrelated files and coalesces Git change bursts", async () => {
    const observed = new ObservedPlacements([{ id: "project-one", root: "repo" }]);
    await observed.start();

    observed.change("repo", "README.md");
    await observed.advanceBy(DEBOUNCE_MS);
    expect(observed.gitReads).toBe(0);

    observed.change("repo", ".git");
    observed.change("repo", ".git");
    observed.change("repo", null);
    await observed.advanceBy(DEBOUNCE_MS);
    expect(observed.gitReads).toBe(1);
    observed.dispose();
  });

  test("recovers errored and temporarily unavailable watchers on the periodic pass", async () => {
    const observed = new ObservedPlacements([
      { id: "project-errored", root: "errored" },
      { id: "project-unavailable", root: "unavailable" },
    ]);
    observed.failNextWatch("unavailable");
    await observed.start();
    expect(observed.watchedRoots()).toEqual(["errored"]);

    observed.watcherFailed("errored");
    expect(observed.watchedRoots()).toEqual([]);
    await observed.advanceBy(RESCAN_INTERVAL_MS);

    expect(observed.watchedRoots()).toEqual(["errored", "unavailable"]);
    expect(observed.closedRoots()).toEqual(["errored"]);
    observed.dispose();
  });

  test("archives missing workspace directories on the periodic pass", async () => {
    const observed = new ObservedPlacements([
      {
        id: "project-one",
        root: "repo",
        workspaces: [{ id: "workspace-one", cwd: "repo/worktree-one" }],
      },
    ]);
    await observed.start();
    await observed.deleteWorkspaceDirectory("workspace-one");

    await observed.advanceBy(RESCAN_INTERVAL_MS);

    expect((await observed.placement("workspace-one"))?.archivedAt).toEqual(expect.any(String));
    expect(observed.workspaceBatches).toEqual([["workspace-one"]]);
    observed.dispose();
  });

  test("preserves a periodic full pass queued behind metadata reconciliation", async () => {
    const observed = new ObservedPlacements([
      {
        id: "project-one",
        root: "repo",
        workspaces: [{ id: "workspace-one", cwd: "repo/worktree-one" }],
      },
    ]);
    await observed.start();
    const metadataRead = observed.holdNextReconciliation();
    observed.change("repo", ".git");
    const metadataPass = observed.advanceBy(DEBOUNCE_MS);
    await metadataRead.started;
    await observed.deleteWorkspaceDirectory("workspace-one");
    const workspaceBatch = observed.waitForWorkspaceBatch();

    await observed.advanceBy(RESCAN_INTERVAL_MS);
    metadataRead.release();
    await metadataPass;
    await workspaceBatch;

    expect((await observed.placement("workspace-one"))?.archivedAt).toEqual(expect.any(String));
    expect(observed.workspaceBatches).toEqual([["workspace-one"]]);
    observed.dispose();
  });

  test("contains a failed reconciliation and converges on the next change", async () => {
    const observed = new ObservedPlacements([
      { id: "project-one", root: "repo", workspaces: [{ id: "workspace-one", cwd: "repo" }] },
    ]);
    await observed.start();
    observed.makeProjectGit("project-one", "main");
    observed.failNextReconciliation(new Error("registry unavailable"));

    observed.change("repo", ".git");
    await observed.advanceBy(DEBOUNCE_MS);
    expect((await observed.placement("workspace-one"))?.kind).toBe("directory");

    observed.change("repo", ".git");
    await observed.advanceBy(DEBOUNCE_MS);
    expect(await observed.placement("workspace-one")).toMatchObject({
      kind: "local_checkout",
      branch: "main",
      displayName: "Durable workspace-one",
    });
    observed.dispose();
  });

  test("deduplicates direct placement and project-derived workspace fanout", async () => {
    const observed = new ObservedPlacements([
      {
        id: "project-one",
        root: "repo",
        workspaces: [
          { id: "workspace-one", cwd: "repo" },
          { id: "workspace-two", cwd: "repo/feature" },
        ],
      },
    ]);
    await observed.start();
    observed.makeProjectGit("project-one", "main");

    observed.change("repo", ".git");
    await observed.advanceBy(DEBOUNCE_MS);

    expect(observed.projectUpdates).toHaveLength(1);
    expect(observed.workspaceBatches).toEqual([["workspace-one", "workspace-two"]]);
    expect(new Set(observed.workspaceBatches[0]).size).toBe(2);
    observed.dispose();
  });

  test("disposal suppresses in-flight mutations and reconciliation fanout", async () => {
    const mutation = new ObservedPlacements([{ id: "project-one", root: "repo" }]);
    await mutation.start();
    const registryRead = mutation.holdNextRegistryRead();
    const adding = mutation.add({ id: "project-late", root: "late" });
    await registryRead.started;
    mutation.dispose();
    registryRead.release();
    await adding;
    expect(mutation.projectUpdates).toEqual([]);
    expect(mutation.watchedRoots()).toEqual([]);

    const reconciliation = new ObservedPlacements([
      { id: "project-one", root: "repo", workspaces: [{ id: "workspace-one", cwd: "repo" }] },
    ]);
    await reconciliation.start();
    reconciliation.makeProjectGit("project-one");
    const workspaceRead = reconciliation.holdNextReconciliation();
    reconciliation.change("repo", ".git");
    const advancing = reconciliation.advanceBy(DEBOUNCE_MS);
    await workspaceRead.started;
    reconciliation.dispose();
    workspaceRead.release();
    await advancing;

    expect(reconciliation.workspaceBatches).toEqual([]);
    expect(reconciliation.watchedRoots()).toEqual([]);
    expect(reconciliation.pendingTimers).toBe(0);
  });

  test("disposal waits for an in-flight reconciliation before its registry files can be removed", async () => {
    const observed = new ObservedPlacements([
      { id: "project-one", root: "repo", workspaces: [{ id: "workspace-one", cwd: "repo" }] },
    ]);
    await observed.start();
    observed.makeProjectGit("project-one");
    const read = observed.holdNextReconciliation();
    observed.change("repo", ".git");
    const advancing = observed.advanceBy(DEBOUNCE_MS);
    await read.started;
    let stopped = false;
    const stopping = observed.dispose().then(() => {
      stopped = true;
      return undefined;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(observed.watchedRoots()).toEqual([]);
      expect(observed.pendingTimers).toBe(0);
    } finally {
      read.release();
      await Promise.all([advancing, stopping]);
    }
    expect(stopped).toBe(true);
    expect((await observed.placement("workspace-one"))?.kind).toBe("local_checkout");
    expect(observed.workspaceBatches).toEqual([]);
  });
});
