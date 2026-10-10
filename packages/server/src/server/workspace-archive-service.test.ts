import { assertWorktreeNotCleaningUp } from "./worktree-use-lock.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ForgeService } from "../services/forge-service.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { createWorktree, type WorktreeConfig } from "../utils/worktree.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  type ArchiveDependencies,
  type ArchiveResult,
  resolveWorkspaceIdAtPath,
} from "./workspace-archive-service.js";
import { WorkspaceAutomationBlockedError } from "./workspace-automation-gate.js";
import { HandoffOwnership } from "./handoff/ownership.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createLogger(): Logger {
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  return logger;
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    }),
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createGitRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "workspace-archive-service-"));
  cleanupPaths.push(tempDir);
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return { tempDir, repoDir };
}

async function createPaseoOwnedWorktree(
  repoDir: string,
  paseoHome: string,
  worktreeSlug: string,
): Promise<WorktreeConfig> {
  return createWorktree({
    cwd: repoDir,
    worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: "main",
      branchName: worktreeSlug,
    },
    runSetup: false,
    paseoHome,
  });
}

interface ArchiveDepsInput {
  paseoHome: string;
  activeWorkspaces: ActiveWorkspaceRef[];
  paseoWorktreesBaseRoot?: string;
  findWorkspaceIdForCwd?: (cwd: string) => Promise<string | null>;
}

interface ArchiveTestDependencies extends ArchiveDependencies {
  activeWorkspaces: ActiveWorkspaceRef[];
  archivedAgentIds: string[];
  archivedSnapshotIds: string[];
}

function createArchiveDeps(input: ArchiveDepsInput): ArchiveTestDependencies {
  const archivedWorkspaceIds = new Set<string>();
  const active = [...input.activeWorkspaces];
  const archivedAgentIds: string[] = [];
  const archivedSnapshotIds: string[] = [];

  return {
    paseoHome: input.paseoHome,
    paseoWorktreesBaseRoot: input.paseoWorktreesBaseRoot,
    github: createGitHubServiceStub(),
    workspaceGitService: {
      getSnapshot: vi.fn(async () => null),
    } as unknown as Pick<WorkspaceGitService, "getSnapshot">,
    agentManager: {
      listAgents: () => [],
      getAgent: () => null,
      archiveAgent: vi.fn(async (agentId: string) => {
        archivedAgentIds.push(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, _archivedAt: string) => {
        archivedSnapshotIds.push(agentId);
        return {};
      }),
    },
    agentStorage: {
      listByWorkspace: async (): Promise<StoredAgentRecord[]> => [],
    } as Pick<AgentStorage, "listByWorkspace">,
    findWorkspaceIdForCwd: input.findWorkspaceIdForCwd ?? vi.fn(async () => null),
    listActiveWorkspaces: async () =>
      active.filter((workspace) => !archivedWorkspaceIds.has(workspace.workspaceId)),
    archiveWorkspaceRecord: async (workspaceId: string) => {
      archivedWorkspaceIds.add(workspaceId);
      const index = active.findIndex((workspace) => workspace.workspaceId === workspaceId);
      if (index !== -1) {
        active.splice(index, 1);
      }
    },
    emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
    markWorkspaceArchiving: vi.fn(),
    clearWorkspaceArchiving: vi.fn(),
    killTerminalsForWorkspace: vi.fn(async () => {}),
    sessionLogger: createLogger(),
    activeWorkspaces: active,
    archivedAgentIds,
    archivedSnapshotIds,
  };
}

function assertArchiveResult(
  result: ArchiveResult,
  expected: {
    archivedWorkspaceIds: string[];
    removedDirectory: boolean;
  },
): void {
  expect(result.archivedWorkspaceIds).toEqual(expected.archivedWorkspaceIds);
  expect(result.removedDirectory).toBe(expected.removedDirectory);
}

async function handoffArchiveFixture() {
  const { tempDir, repoDir } = createGitRepo();
  writeFileSync(
    path.join(repoDir, "paseo.json"),
    JSON.stringify({
      worktree: {
        teardown: [
          "node -e \"require('node:fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/handoff-teardown.txt', 'ran')\"",
        ],
      },
    }),
  );
  for (const name of ["selected", "sibling"]) {
    mkdirSync(path.join(repoDir, name));
    writeFileSync(path.join(repoDir, name, "notes.txt"), "retained content");
  }
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "archive fixture"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  const paseoHome = path.join(tempDir, ".paseo");
  const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "handoff-archive");
  const cwd = worktree.worktreePath;
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "handoff-archive-workspace",
    projectId: "handoff-archive-project",
    cwd,
    kind: "worktree",
    worktreeRoot: cwd,
    mainRepoRoot: repoDir,
    isPaseoOwnedWorktree: true,
    displayName: "Handoff archive",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const registryPath = path.join(tempDir, "workspaces.json");
  const registry = new FileBackedWorkspaceRegistry(registryPath, createLogger());
  await registry.initialize();
  await registry.upsert(workspace);
  const ownership = new HandoffOwnership({
    directory: path.join(tempDir, "ownership"),
    sourceServerId: "source-host",
  });
  await ownership.initialize();
  const deps = createArchiveDeps({ paseoHome, activeWorkspaces: [workspace] });
  deps.handoffOwnership = ownership;
  deps.getWorkspace = (id) => registry.get(id);
  deps.listActiveWorkspaces = async () =>
    (await registry.list()).filter((record) => !record.archivedAt);
  deps.archiveWorkspaceRecord = async (id) => {
    await registry.archive(id, new Date().toISOString());
  };
  deps.stopWorkspaceSetup = vi.fn(async () => {});
  const transfer = {
    id: randomUUID(),
    cwd,
    workspaceId: workspace.workspaceId,
    agentIds: [],
    destinationServerId: "destination-host",
    reservationId: randomUUID(),
  };
  return { tempDir, repoDir, cwd, workspace, registryPath, registry, deps, ownership, transfer };
}

test("automatic cleanup from an archived workspace cannot delete its reopened incarnation", async () => {
  const { repoDir, cwd, workspace, registry, registryPath, deps } = await handoffArchiveFixture();
  const expectedIncarnation = workspace.incarnation;
  await archiveByScope(deps, {
    scope: { kind: "workspace", workspaceId: workspace.workspaceId },
    requestId: "explicit-archive",
  });
  expect(existsSync(cwd)).toBe(false);
  execFileSync("git", ["worktree", "add", cwd, "handoff-archive"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  await registry.upsert({ ...workspace, archivedAt: null });
  const restarted = new FileBackedWorkspaceRegistry(registryPath, createLogger());
  deps.getWorkspace = (id) => restarted.get(id);
  deps.listActiveWorkspaces = async () =>
    (await restarted.list()).filter((record) => !record.archivedAt);
  deps.archiveWorkspaceRecord = (id) => restarted.archive(id, new Date().toISOString());
  rmSync(path.join(repoDir, "handoff-teardown.txt"));
  vi.mocked(deps.stopWorkspaceSetup!).mockClear();
  vi.mocked(deps.killTerminalsForWorkspace).mockClear();
  vi.mocked(deps.markWorkspaceArchiving).mockClear();

  const request = {
    scope: { kind: "workspace" as const, workspaceId: workspace.workspaceId },
    requestId: "old-schedule-finally",
    automatic: { expectedIncarnation },
  };
  expect(await archiveByScope(deps, request)).toEqual({
    archivedAgentIds: [],
    archivedWorkspaceIds: [],
    removedDirectory: false,
  });
  expect(readFileSync(path.join(cwd, "selected", "notes.txt"), "utf8")).toBe("retained content");
  expect(existsSync(path.join(repoDir, "handoff-teardown.txt"))).toBe(false);
  expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
  expect(deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
  expect(deps.markWorkspaceArchiving).not.toHaveBeenCalled();
  const reopened = await registry.get(workspace.workspaceId);
  expect(reopened?.archivedAt).toBe(null);
  expect(reopened?.incarnation).not.toBe(expectedIncarnation);
  expect(
    await archiveByScope(deps, {
      ...request,
      automatic: { expectedIncarnation: reopened!.incarnation },
    }),
  ).toEqual({
    archivedAgentIds: [],
    archivedWorkspaceIds: [workspace.workspaceId],
    removedDirectory: true,
  });
});

test("automatic cleanup rechecks the opening after waiting for admission", async () => {
  const { cwd, workspace, registry, deps, ownership } = await handoffArchiveFixture();
  const entered = deferred();
  const resume = deferred();
  const acquire = ownership.acquireMutation.bind(ownership);
  const admission = vi.spyOn(ownership, "acquireMutation").mockImplementationOnce(async (scope) => {
    const release = await acquire(scope);
    entered.resolve();
    await resume.promise;
    return release;
  });
  const archive = archiveByScope(deps, {
    scope: { kind: "workspace", workspaceId: workspace.workspaceId },
    requestId: "waiting-cleanup",
    automatic: { expectedIncarnation: workspace.incarnation },
  });
  await entered.promise;
  try {
    await registry.archive(workspace.workspaceId, new Date().toISOString());
    await registry.upsert({ ...workspace, archivedAt: null });
  } finally {
    resume.resolve();
    admission.mockRestore();
  }
  expect(await archive).toEqual({
    archivedAgentIds: [],
    archivedWorkspaceIds: [],
    removedDirectory: false,
  });
  expect(existsSync(cwd)).toBe(true);
  expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
  expect(deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
  expect(deps.markWorkspaceArchiving).not.toHaveBeenCalled();
});

test.each(["archived", "missing-opening"])(
  "automatic cleanup leaves %s workspaces untouched",
  async (state) => {
    const { cwd, workspace, registry, deps } = await handoffArchiveFixture();
    if (state === "archived")
      await registry.archive(workspace.workspaceId, new Date().toISOString());
    expect(
      await archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId: workspace.workspaceId },
        requestId: "stale-cleanup",
        automatic: {
          expectedIncarnation: state === "archived" ? workspace.incarnation : undefined,
        },
      }),
    ).toEqual({ archivedAgentIds: [], archivedWorkspaceIds: [], removedDirectory: false });
    expect(existsSync(cwd)).toBe(true);
    expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
  },
);

test("archive reserves the backing worktree before stopping its writers", async () => {
  const { cwd, workspace, deps } = await handoffArchiveFixture();
  const entered = deferred();
  const resume = deferred();
  deps.stopWorkspaceSetup = async () => {
    entered.resolve();
    await resume.promise;
  };
  const archiving = archiveByScope(deps, {
    scope: { kind: "workspace", workspaceId: workspace.workspaceId },
    requestId: "held-archive",
    automatic: { expectedIncarnation: workspace.incarnation },
  });
  await entered.promise;
  try {
    expect(() => assertWorktreeNotCleaningUp(cwd)).toThrow("Worktree is cleaning up");
    expect(() => assertWorktreeNotCleaningUp(path.join(cwd, "selected"))).toThrow(
      "Worktree is cleaning up",
    );
  } finally {
    resume.resolve();
    await archiving;
  }
  expect(() => assertWorktreeNotCleaningUp(cwd)).not.toThrow();
});

test("an unreadable workspace registry refuses cleanup without deleting retained work", async () => {
  const { repoDir, cwd, workspace, registryPath, deps } = await handoffArchiveFixture();
  const saved = readFileSync(registryPath, "utf8");
  writeFileSync(registryPath, "{damaged registry");
  const cold = new FileBackedWorkspaceRegistry(registryPath, createLogger());
  deps.getWorkspace = (id) => cold.get(id);
  deps.listActiveWorkspaces = async () =>
    (await cold.list()).filter((record) => !record.archivedAt);
  deps.archiveWorkspaceRecord = (id) => cold.archive(id, new Date().toISOString());

  const request = {
    scope: { kind: "worktree" as const, targetPath: cwd },
    requestId: "damaged-retained-workspace-registry",
  };
  await expect(archiveByScope(deps, request)).rejects.toThrow("Failed to load registry");
  expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
  expect(deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
  expect(deps.markWorkspaceArchiving).not.toHaveBeenCalled();
  expect(readFileSync(path.join(cwd, "selected", "notes.txt"), "utf8")).toBe("retained content");
  expect(existsSync(path.join(repoDir, "handoff-teardown.txt"))).toBe(false);
  expect(readFileSync(registryPath, "utf8")).toBe("{damaged registry");

  writeFileSync(registryPath, saved);
  expect(await cold.get(workspace.workspaceId)).toEqual(workspace);
  expect(await archiveByScope(deps, request)).toMatchObject({
    archivedWorkspaceIds: [workspace.workspaceId],
    removedDirectory: true,
  });
});

test("handoff refuses archive before stopping runtimes, persisting records or running teardown", async () => {
  const { repoDir, cwd, workspace, registry, deps, ownership, transfer } =
    await handoffArchiveFixture();
  await ownership.prepare(transfer);
  const request = {
    scope: { kind: "workspace" as const, workspaceId: workspace.workspaceId },
    requestId: "handoff-archive",
  };

  await expect(archiveByScope(deps, request)).rejects.toMatchObject({ code: "fenced" });
  expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
  expect(deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
  expect(deps.markWorkspaceArchiving).not.toHaveBeenCalled();
  expect(await registry.get(workspace.workspaceId)).toEqual(workspace);
  expect(readFileSync(path.join(cwd, "selected", "notes.txt"), "utf8")).toBe("retained content");
  expect(existsSync(path.join(repoDir, "handoff-teardown.txt"))).toBe(false);

  await ownership.cancel(transfer.id);
  expect(await archiveByScope(deps, request)).toEqual({
    archivedAgentIds: [],
    archivedWorkspaceIds: [workspace.workspaceId],
    removedDirectory: true,
  });
  expect(readFileSync(path.join(repoDir, "handoff-teardown.txt"), "utf8")).toBe("ran");
  expect(existsSync(cwd)).toBe(false);
  expect((await registry.get(workspace.workspaceId))?.archivedAt).toEqual(expect.any(String));
});

test.each(["sibling", "source repository"] as const)(
  "handoff protects the %s from worktree archive effects",
  async (scope) => {
    const { repoDir, cwd, workspace, registry, deps, ownership, transfer } =
      await handoffArchiveFixture();
    await ownership.prepare({
      ...transfer,
      workspaceId: "other-workspace",
      cwd: scope === "sibling" ? path.join(cwd, "sibling") : repoDir,
    });
    await expect(
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId: workspace.workspaceId },
        requestId: "handoff-archive-shared",
      }),
    ).rejects.toMatchObject({ code: "fenced" });
    expect(await registry.get(workspace.workspaceId)).toEqual(workspace);
    expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(path.join(repoDir, "handoff-teardown.txt"))).toBe(false);

    // If a later scope denied admission, earlier admissions must not leak.
    await ownership.cancel(transfer.id);
    const next = { ...transfer, id: randomUUID() };
    await ownership.prepare(next);
    expect((await ownership.markReady(next.id, "a".repeat(64))).state).toBe("ready");
  },
);

test("handoff checks every workspace identity before archiving a shared worktree", async () => {
  const { tempDir, cwd, workspace, registry, deps, ownership, transfer } =
    await handoffArchiveFixture();
  const sibling = {
    ...workspace,
    workspaceId: "sibling-workspace",
    cwd: path.join(cwd, "sibling"),
  };
  await registry.upsert(sibling);
  const elsewhere = path.join(tempDir, "elsewhere");
  mkdirSync(elsewhere);
  await ownership.prepare({ ...transfer, cwd: elsewhere, workspaceId: sibling.workspaceId });
  await expect(
    archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: cwd },
      requestId: "handoff-all-workspaces",
    }),
  ).rejects.toMatchObject({ code: "fenced" });
  expect(await registry.get(workspace.workspaceId)).toEqual(workspace);
  expect(await registry.get(sibling.workspaceId)).toEqual(sibling);
  expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
  expect(deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
  expect(existsSync(cwd)).toBe(true);
  await ownership.cancel(transfer.id);
  const next = { ...transfer, id: randomUUID() };
  await ownership.prepare(next);
  expect((await ownership.markReady(next.id, "a".repeat(64))).state).toBe("ready");
});

test("handoff rejects deletion retries for an archived workspace by identity", async () => {
  const { tempDir, cwd, workspace, registry, deps, ownership, transfer } =
    await handoffArchiveFixture();
  await registry.archive(workspace.workspaceId, "2026-10-09T00:00:00.000Z");
  const archived = await registry.get(workspace.workspaceId);
  const elsewhere = path.join(tempDir, "elsewhere");
  mkdirSync(elsewhere);
  await ownership.prepare({ ...transfer, cwd: elsewhere });
  await expect(
    archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: workspace.workspaceId },
      requestId: "handoff-archive-retry",
    }),
  ).rejects.toMatchObject({ code: "fenced" });
  expect(await registry.get(workspace.workspaceId)).toEqual(archived);
  expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
  expect(existsSync(cwd)).toBe(true);
});

test("handoff protects a worktree path even when no active workspace record remains", async () => {
  const { cwd, workspace, registry, deps, ownership, transfer } = await handoffArchiveFixture();
  await registry.remove(workspace.workspaceId);
  await ownership.prepare(transfer);
  await expect(
    archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: cwd },
      requestId: "handoff-orphan-worktree",
    }),
  ).rejects.toMatchObject({ code: "fenced" });
  expect(existsSync(cwd)).toBe(true);
  expect(deps.stopWorkspaceSetup).not.toHaveBeenCalled();
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("handoff drains an admitted archive through deletion and the final workspace update", async () => {
  const { repoDir, cwd, workspace, registryPath, deps, ownership, transfer } =
    await handoffArchiveFixture();
  const stopEntered = deferred();
  const finishStop = deferred();
  const updateEntered = deferred();
  const finishUpdate = deferred();
  deps.stopWorkspaceSetup = async () => {
    stopEntered.resolve();
    await finishStop.promise;
  };
  let updates = 0;
  deps.emitWorkspaceUpdatesForWorkspaceIds = async () => {
    updates++;
    if (updates === 2) {
      updateEntered.resolve();
      await finishUpdate.promise;
    }
  };
  const archiving = archiveByScope(deps, {
    scope: { kind: "workspace", workspaceId: workspace.workspaceId },
    requestId: "handoff-admitted-archive",
  });
  await stopEntered.promise;
  await ownership.prepare(transfer);
  try {
    await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
      code: "invalid_state",
    });
    finishStop.resolve();
    await updateEntered.promise;
    const persisted = new FileBackedWorkspaceRegistry(registryPath, createLogger());
    await persisted.initialize();
    expect((await persisted.get(workspace.workspaceId))?.archivedAt).toEqual(expect.any(String));
    expect(readFileSync(path.join(repoDir, "handoff-teardown.txt"), "utf8")).toBe("ran");
    expect(existsSync(cwd)).toBe(false);
    await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
      code: "invalid_state",
    });
  } finally {
    finishStop.resolve();
    finishUpdate.resolve();
    await archiving;
  }
  expect(await archiving).toEqual({
    archivedAgentIds: [],
    archivedWorkspaceIds: [workspace.workspaceId],
    removedDirectory: true,
  });
  await ownership.drain(transfer.id);
  expect((await ownership.markReady(transfer.id, "a".repeat(64))).state).toBe("ready");
});

test("handoff releases archive admission when publishing its final update fails", async () => {
  const { workspace, deps, ownership, transfer } = await handoffArchiveFixture();
  const stopEntered = deferred();
  const finishStop = deferred();
  deps.stopWorkspaceSetup = async () => {
    stopEntered.resolve();
    await finishStop.promise;
  };
  let updates = 0;
  deps.emitWorkspaceUpdatesForWorkspaceIds = async () => {
    updates++;
    if (updates === 2) throw new Error("workspace update failed");
  };
  const archiving = archiveByScope(deps, {
    scope: { kind: "workspace", workspaceId: workspace.workspaceId },
    requestId: "handoff-failed-archive-update",
  });
  const failed = expect(archiving).rejects.toThrow("workspace update failed");
  await stopEntered.promise;
  await ownership.prepare(transfer);
  finishStop.resolve();
  await failed;
  await ownership.drain(transfer.id);
  expect((await ownership.markReady(transfer.id, "a".repeat(64))).state).toBe("ready");
});

describe("archiveByScope", () => {
  test("workspace scope archives the record and removes the directory on last reference", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "last-ref-workspace");
    const workspaceId = "ws-last-ref";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-last-ref-workspace",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("workspace scope runs teardown while keeping a directory referenced by a sibling", async () => {
    const { tempDir, repoDir } = createGitRepo();
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/shared-teardown.log', 'ok')\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "shared teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "sibling-workspace");
    const workspaceA = "ws-sibling-a";
    const workspaceB = "ws-sibling-b";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "local_checkout" },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: workspaceA },
        requestId: "req-sibling-workspace",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceA],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect(readFileSync(path.join(repoDir, "shared-teardown.log"), "utf8")).toBe("ok");
  });

  test("workspace scope skips teardown while repository automation is blocked", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const marker = path.join(repoDir, "blocked-teardown.log");
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [`node -e "require('fs').writeFileSync('${marker}', 'unsafe')"`],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "blocked teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "blocked-teardown");
    const workspaceId = "ws-blocked-teardown";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        {
          workspaceId,
          cwd: worktree.worktreePath,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
      ],
    });
    deps.assertWorkspaceAutomationAllowed = async () => {
      throw new WorkspaceAutomationBlockedError({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      });
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-blocked-teardown",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceId]);
    expect(existsSync(marker)).toBe(false);
  });

  test("workspace scope keeps a worktree for an active workspace in a subdirectory", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "subdirectory-sibling");
    const sourceWorkspaceId = "ws-subdirectory-source";
    const siblingWorkspaceId = "ws-subdirectory-sibling";
    const siblingDirectory = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(siblingDirectory, { recursive: true });

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: sourceWorkspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: siblingWorkspaceId,
            cwd: siblingDirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: sourceWorkspaceId },
        requestId: "req-subdirectory-sibling",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [sourceWorkspaceId],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("archiving a subdirectory workspace keeps its active worktree root", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "subdirectory-target");
    const rootWorkspaceId = "ws-subdirectory-root";
    const subdirectoryWorkspaceId = "ws-subdirectory-target";
    const subdirectory = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(subdirectory, { recursive: true });

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: rootWorkspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: subdirectoryWorkspaceId,
            cwd: subdirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: subdirectoryWorkspaceId },
        requestId: "req-subdirectory-target",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [subdirectoryWorkspaceId],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("workspace scope runs teardown from the exact nested workspace before deleting its worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const nestedRelative = path.join("packages", "app");
    const sourceNested = path.join(repoDir, nestedRelative);
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(
      path.join(sourceNested, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/nested-teardown.log', process.cwd())\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "nested teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "nested-teardown");
    const workspaceCwd = path.join(worktree.worktreePath, nestedRelative);
    const matchesWorkspaceCwd = createRealpathAwarePathMatcher(workspaceCwd);
    const workspaceId = "ws-nested-teardown";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: workspaceCwd,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
            mainRepoRoot: repoDir,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-nested-teardown",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(
      matchesWorkspaceCwd(readFileSync(path.join(repoDir, "nested-teardown.log"), "utf8")),
    ).toBe(true);
  });

  test("worktree scope archives root and subdirectory workspaces before removing the backing worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const nestedRelative = path.join("packages", "app");
    const sourceNested = path.join(repoDir, nestedRelative);
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"const fs=require('fs');const out=process.env.PASEO_SOURCE_CHECKOUT_PATH+'/root-scope-teardown.log';if(fs.existsSync(out))process.exit(2);fs.writeFileSync(out,'ok')\"",
          ],
        },
      }),
    );
    writeFileSync(
      path.join(sourceNested, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH+'/nested-scope-teardown.log','ok')\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "scope teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "worktree-scope");
    const workspaceA = "ws-worktree-a";
    const workspaceB = "ws-worktree-b";
    const workspaceC = "ws-worktree-subdirectory";
    const subdirectory = path.join(worktree.worktreePath, nestedRelative);

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: workspaceA,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: workspaceB,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: workspaceC,
            cwd: subdirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-worktree-scope",
      },
    );

    expect(result.archivedWorkspaceIds).toEqual(
      expect.arrayContaining([workspaceA, workspaceB, workspaceC]),
    );
    expect(result.archivedWorkspaceIds).toHaveLength(3);
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(readFileSync(path.join(repoDir, "root-scope-teardown.log"), "utf8")).toBe("ok");
    expect(readFileSync(path.join(repoDir, "nested-scope-teardown.log"), "utf8")).toBe("ok");
  });

  test("workspace scope never removes a non-Paseo-owned directory", async () => {
    const { tempDir } = createGitRepo();
    const localCheckoutDir = mkdtempSync(path.join(tempDir, "local-checkout-"));
    const workspaceId = "ws-local-checkout";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome: path.join(tempDir, ".paseo"),
        activeWorkspaces: [{ workspaceId, cwd: localCheckoutDir, kind: "local_checkout" }],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-local-checkout",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: false,
    });
    expect(existsSync(localCheckoutDir)).toBe(true);
  });

  test("worktree scope keeps the directory when one record teardown fails", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "partial-failure");
    const workspaceA = "ws-partial-a";
    const workspaceB = "ws-partial-b";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
        { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (workspaceId: string) => {
      if (workspaceId === workspaceA) {
        throw new Error("intentional teardown failure");
      }
      return originalArchiveWorkspaceRecord(workspaceId);
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: worktree.worktreePath },
      requestId: "req-partial-failure",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceB]);
    expect(result.archivedWorkspaceIds).not.toContain(workspaceA);
    expect(result.removedDirectory).toBe(false);
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("workspace scope with unknown workspace id is a clean no-op", async () => {
    const { tempDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = vi.fn(async (workspaceId: string) => {
      return originalArchiveWorkspaceRecord(workspaceId);
    });

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "ws-does-not-exist" },
      requestId: "req-unknown-workspace",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: [],
      removedDirectory: false,
    });
    expect(deps.markWorkspaceArchiving).not.toHaveBeenCalled();
    expect(deps.archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(deps.emitWorkspaceUpdatesForWorkspaceIds).not.toHaveBeenCalled();
  });

  test("worktree scope removes an owned directory with zero matching records", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "zero-records");

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-zero-records",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("marks archiving, emits an upsert carrying the archiving state, then clears it and emits a remove", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "lifecycle");
    const workspaceId = "ws-lifecycle";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });

    const archivingByWorkspaceId = new Map<string, string>();
    type LifecycleEvent =
      | { type: "mark"; workspaceIds: string[]; archivingAt: string }
      | {
          type: "emit";
          workspaceIds: string[];
          updates: Array<{
            kind: "upsert" | "remove";
            workspaceId: string;
            archivingAt: string | null;
          }>;
        }
      | { type: "archive"; workspaceId: string }
      | { type: "clear"; workspaceIds: string[] };
    const events: LifecycleEvent[] = [];

    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (id: string) => {
      await originalArchiveWorkspaceRecord(id);
      events.push({ type: "archive", workspaceId: id });
    };
    deps.markWorkspaceArchiving = vi.fn((workspaceIds: Iterable<string>, archivingAt: string) => {
      for (const id of workspaceIds) {
        archivingByWorkspaceId.set(id, archivingAt);
      }
      events.push({ type: "mark", workspaceIds: Array.from(workspaceIds), archivingAt });
    });
    deps.clearWorkspaceArchiving = vi.fn((workspaceIds: Iterable<string>) => {
      for (const id of workspaceIds) {
        archivingByWorkspaceId.delete(id);
      }
      events.push({ type: "clear", workspaceIds: Array.from(workspaceIds) });
    });
    deps.emitWorkspaceUpdatesForWorkspaceIds = vi.fn(async (workspaceIds: Iterable<string>) => {
      const ids = Array.from(workspaceIds);
      const activeIds = new Set<string>();
      for (const workspace of deps.activeWorkspaces) {
        activeIds.add(workspace.workspaceId);
      }
      const updates: Array<{
        kind: "upsert" | "remove";
        workspaceId: string;
        archivingAt: string | null;
      }> = [];
      for (const id of ids) {
        const archivingAt = archivingByWorkspaceId.get(id) ?? null;
        if (archivingAt && activeIds.has(id)) {
          updates.push({ kind: "upsert", workspaceId: id, archivingAt });
        } else {
          updates.push({ kind: "remove", workspaceId: id, archivingAt: null });
        }
      }
      events.push({ type: "emit", workspaceIds: ids, updates });
    });

    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-lifecycle",
    });

    expect(events.map((event) => event.type)).toEqual(["mark", "emit", "archive", "clear", "emit"]);

    const firstEmit = events[1] as Extract<LifecycleEvent, { type: "emit" }>;
    expect(firstEmit.workspaceIds).toEqual([workspaceId]);
    expect(firstEmit.updates).toEqual([
      { kind: "upsert", workspaceId, archivingAt: expect.any(String) },
    ]);

    const secondEmit = events[4] as Extract<LifecycleEvent, { type: "emit" }>;
    expect(secondEmit.workspaceIds).toEqual([workspaceId]);
    expect(secondEmit.updates).toEqual([{ kind: "remove", workspaceId, archivingAt: null }]);
  });

  test("archives stored snapshots only for the target workspace", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "snapshot-scope");
    const targetWorkspaceId = "ws-snapshot-target";
    const otherWorkspaceId = "ws-snapshot-other";
    const liveAgentId = "agent-live";
    const targetStoredAgentId = "agent-stored-target";
    const otherStoredAgentId = "agent-stored-other";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: targetWorkspaceId, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    deps.agentManager = {
      listAgents: () => [{ id: liveAgentId, workspaceId: targetWorkspaceId }] as ManagedAgent[],
      getAgent: (agentId: string) =>
        agentId === liveAgentId ? ({ id: liveAgentId } as ManagedAgent) : null,
      archiveAgent: vi.fn(async (agentId: string) => {
        deps.archivedAgentIds.push(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, _archivedAt: string) => {
        deps.archivedSnapshotIds.push(agentId);
        return {};
      }),
    };
    deps.agentStorage = {
      listByWorkspace: async (workspaceId: string) =>
        workspaceId === targetWorkspaceId
          ? ([
              { id: targetStoredAgentId, workspaceId: targetWorkspaceId, archivedAt: null },
            ] as StoredAgentRecord[])
          : ([
              { id: otherStoredAgentId, workspaceId: otherWorkspaceId, archivedAt: null },
            ] as StoredAgentRecord[]),
    } as Pick<AgentStorage, "listByWorkspace">;

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: targetWorkspaceId },
      requestId: "req-snapshot-scope",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: [targetWorkspaceId],
      removedDirectory: true,
    });
    expect(result.archivedAgentIds).toContain(liveAgentId);
    expect(result.archivedAgentIds).toContain(targetStoredAgentId);
    expect(result.archivedAgentIds).not.toContain(otherStoredAgentId);
    expect(deps.archivedSnapshotIds).toEqual([targetStoredAgentId]);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("archives the durable snapshot when an observed live agent closes before teardown", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const workspaceId = "ws-live-teardown-race";
    const agentId = "agent-live-teardown-race";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: repoDir, kind: "local_checkout" }],
    });
    deps.agentManager = {
      listAgents: () => [{ id: agentId, workspaceId }] as ManagedAgent[],
      getAgent: () => null,
      archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
      archiveSnapshot: vi.fn(async (id: string) => {
        deps.archivedSnapshotIds.push(id);
        return {};
      }),
    };
    deps.agentStorage = {
      list: async () => [{ id: agentId, workspaceId, archivedAt: null }] as StoredAgentRecord[],
    } as Pick<AgentStorage, "list">;

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-live-teardown-race",
    });

    expect(result.archivedAgentIds).toContain(agentId);
    expect(deps.archivedSnapshotIds).toEqual([agentId]);
    expect(deps.agentManager.archiveAgent).not.toHaveBeenCalled();
  });

  test("worktree scope archives three workspaces on the directory and removes it", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "worktree-scope-n3");
    const workspaceA = "ws-worktree-n3-a";
    const workspaceB = "ws-worktree-n3-b";
    const workspaceC = "ws-worktree-n3-c";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceC, cwd: worktree.worktreePath, kind: "local_checkout" },
        ],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-worktree-scope-n3",
      },
    );

    expect(result.archivedWorkspaceIds).toEqual(
      expect.arrayContaining([workspaceA, workspaceB, workspaceC]),
    );
    expect(result.archivedWorkspaceIds).toHaveLength(3);
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });
});

describe("resolveWorkspaceIdAtPath", () => {
  test("prefers the worktree-kind record on an exact cwd tie", async () => {
    const targetPath = "/worktrees/repo/feature";

    const result = await resolveWorkspaceIdAtPath(
      {
        listActiveWorkspaces: async () => [
          { workspaceId: "ws-local", cwd: targetPath, kind: "local_checkout" },
          { workspaceId: "ws-worktree", cwd: targetPath, kind: "worktree" },
        ],
        findWorkspaceIdForCwd: vi.fn(async () => "ws-local"),
      },
      targetPath,
    );

    expect(result).toBe("ws-worktree");
  });

  test("falls back to the path resolver when there is no exact match", async () => {
    const targetPath = "/worktrees/repo/feature";

    const result = await resolveWorkspaceIdAtPath(
      {
        listActiveWorkspaces: async () => [
          { workspaceId: "ws-nested", cwd: "/worktrees/repo", kind: "worktree" },
        ],
        findWorkspaceIdForCwd: vi.fn(async () => "ws-nested"),
      },
      targetPath,
    );

    expect(result).toBe("ws-nested");
  });
});
