import pino from "pino";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { HandoffOwnership } from "./handoff/ownership.js";
import {
  readPaseoWorktreeMetadata,
  writePaseoWorktreeMetadata,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
} from "../utils/worktree-metadata.js";
import type { GeneratedWorkspaceName } from "./worktree-branch-name-generator.js";

const temporaryDirs: string[] = [];
afterEach(async () => {
  for (const root of temporaryDirs.splice(0)) await rm(root, { recursive: true, force: true });
});

async function handoffFixture(
  options: {
    generate?: () => Promise<GeneratedWorkspaceName | null>;
    beforeUpdate?: () => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "paseo-handoff-auto-name-"));
  temporaryDirs.push(root);
  const repo = join(root, "repo");
  const cwd = join(root, "worktree");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  git("worktree", "add", "-b", "placeholder", cwd);
  writePaseoWorktreeMetadata(cwd, { baseRefName: "main", serverId: "source-host" });
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata(cwd, { placeholderBranchName: "placeholder" });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-auto-name",
    projectId: "project-auto-name",
    cwd,
    kind: "worktree",
    displayName: "placeholder",
    branch: "placeholder",
    worktreeRoot: cwd,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  });
  const registry = new FileBackedWorkspaceRegistry(
    join(root, "workspaces.json"),
    pino({ level: "silent" }),
  );
  await registry.initialize();
  await registry.upsert(workspace);
  const ownership = new HandoffOwnership({
    directory: join(root, "ownership"),
    sourceServerId: "source-host",
  });
  await ownership.initialize();
  const transfer = {
    id: randomUUID(),
    cwd,
    workspaceId: workspace.workspaceId,
    agentIds: ["agent-1"],
    destinationServerId: "target-host",
    reservationId: randomUUID(),
  };
  const events: string[] = [];
  const errors: string[] = [];
  let generations = 0;
  const logger = pino(
    { level: "warn" },
    {
      write(line) {
        const entry = JSON.parse(line) as { err: { message: string } };
        errors.push(entry.err.message);
        events.push("failed");
      },
    },
  );
  const autoName = new WorkspaceAutoName({
    handoffOwnership: ownership,
    agentManager: {
      replaceTitleIfUnchanged: async () => {
        events.push("agent-title");
        return true;
      },
    } as unknown as AgentManager,
    workspaceRegistry: {
      update: async (id, updater) => {
        await options.beforeUpdate?.();
        return registry.update(id, updater);
      },
    },
    workspaceGitService: {} as WorkspaceGitService,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: {
      notifyGitMutation: async () => {
        events.push("git-refresh");
      },
    },
    emitWorkspaceUpdateForCwd: async () => {
      events.push("worktree-title");
    },
    emitWorkspaceUpdateForWorkspaceId: async () => {
      events.push("directory-title");
    },
    logger,
    generateWorkspaceName: async () => {
      generations++;
      return options.generate
        ? options.generate()
        : { title: "Generated title", branch: "generated-branch" };
    },
  });
  return {
    root,
    cwd,
    workspace,
    registry,
    ownership,
    transfer,
    autoName,
    events,
    errors,
    generationCount: () => generations,
    branch: () => git("-C", cwd, "branch", "--show-current"),
  };
}

test("handoff blocks automatic branch naming without consuming its pending metadata, then cancellation permits retry", async () => {
  const fixture = await handoffFixture();
  const { autoName, workspace, ownership, transfer, events, errors, registry, cwd } = fixture;
  await ownership.prepare(transfer);
  const metadata = readPaseoWorktreeMetadata(cwd);
  const input = { workspace, firstAgentContext: { prompt: "Name this worktree" } };
  autoName.scheduleForWorktree(input);
  await expect.poll(() => events.length).toBeGreaterThan(0);
  expect(events).toEqual(["failed"]);
  expect(errors).toEqual([`Workspace is held by handoff ${transfer.id} (preparing)`]);
  expect(fixture.generationCount()).toBe(0);
  expect(fixture.branch()).toBe("placeholder");
  expect(readPaseoWorktreeMetadata(cwd)).toEqual(metadata);
  expect(await registry.get(workspace.workspaceId)).toEqual(workspace);

  await ownership.cancel(transfer.id);
  autoName.scheduleForWorktree(input);
  await expect.poll(() => events).toEqual(["failed", "git-refresh", "worktree-title"]);
  expect(fixture.branch()).toBe("generated-branch");
  expect(await registry.get(workspace.workspaceId)).toMatchObject({
    title: "Generated title",
    branch: "generated-branch",
  });
  expect(readPaseoWorktreeMetadata(cwd)).toMatchObject({
    firstAgentBranchAutoName: { status: "attempted" },
  });
});

test.each(["directory", "agent"] as const)(
  "handoff blocks automatic %s titles by identity even with a different cwd",
  async (kind) => {
    const fixture = await handoffFixture();
    const { ownership, transfer, autoName, workspace, events } = fixture;
    await ownership.prepare(transfer);
    const firstAgentContext = { prompt: "Generate a title" };
    // The cwd is outside the fenced tree; the workspace/agent identity must still win.
    const cwd = join(fixture.root, "repo");
    if (kind === "directory") {
      autoName.scheduleForDirectory({ workspaceId: workspace.workspaceId, cwd, firstAgentContext });
    } else {
      autoName.scheduleForAgent({
        agentId: "agent-1",
        cwd,
        firstAgentContext,
        provisionalTitle: "Generate a title",
      });
    }
    await expect.poll(() => events.length).toBe(1);
    expect(events).toEqual(["failed"]);
    expect(fixture.errors).toEqual([`Workspace is held by handoff ${transfer.id} (preparing)`]);
    expect(fixture.generationCount()).toBe(0);
    expect(await fixture.registry.get(workspace.workspaceId)).toEqual(workspace);
  },
);

test("handoff drains an admitted automatic rename through generation and persisted title update", async () => {
  const generationStarted = deferred();
  const finishGeneration = deferred();
  const writeStarted = deferred();
  const finishWrite = deferred();
  const fixture = await handoffFixture({
    generate: async () => {
      generationStarted.resolve();
      await finishGeneration.promise;
      return { title: "Generated title", branch: "generated-branch" };
    },
    beforeUpdate: async () => {
      writeStarted.resolve();
      await finishWrite.promise;
    },
  });
  const { ownership, transfer, autoName, workspace, registry } = fixture;
  autoName.scheduleForWorktree({ workspace, firstAgentContext: { prompt: "Name this worktree" } });
  await generationStarted.promise;
  try {
    await ownership.prepare(transfer);
    await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
      code: "invalid_state",
    });
    finishGeneration.resolve();
    await writeStarted.promise;
    expect(fixture.branch()).toBe("generated-branch");
    expect(await registry.get(workspace.workspaceId)).toEqual(workspace);
    await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
      code: "invalid_state",
    });
  } finally {
    finishGeneration.resolve();
    finishWrite.resolve();
    await ownership.drain(transfer.id);
  }
  expect((await ownership.markReady(transfer.id, "a".repeat(64))).state).toBe("ready");
  const reloaded = new FileBackedWorkspaceRegistry(
    join(fixture.root, "workspaces.json"),
    pino({ level: "silent" }),
  );
  await reloaded.initialize();
  expect(await reloaded.get(workspace.workspaceId)).toMatchObject({
    title: "Generated title",
    branch: "generated-branch",
  });
  expect(fixture.events).toEqual(["git-refresh", "worktree-title"]);
});

test("handoff protects the branch shared with a fenced sibling directory workspace", async () => {
  const fixture = await handoffFixture();
  const selectedDirectory = join(fixture.cwd, "selected");
  const siblingDirectory = join(fixture.cwd, "sibling");
  await mkdir(selectedDirectory);
  await mkdir(siblingDirectory);
  await fixture.ownership.prepare({
    ...fixture.transfer,
    cwd: siblingDirectory,
    workspaceId: "sibling-workspace",
    agentIds: [],
  });
  fixture.autoName.scheduleForWorktree({
    workspace: { ...fixture.workspace, cwd: selectedDirectory },
    firstAgentContext: { prompt: "Rename the shared branch" },
  });
  await expect.poll(() => fixture.events.length).toBeGreaterThan(0);
  expect(fixture.events).toEqual(["failed"]);
  expect(fixture.errors).toEqual([
    `Workspace is held by handoff ${fixture.transfer.id} (preparing)`,
  ]);
  expect(fixture.branch()).toBe("placeholder");
  expect(fixture.generationCount()).toBe(0);
});

test("handoff releases the admitted auto-name lease when generation fails", async () => {
  const generationStarted = deferred();
  const finishGeneration = deferred();
  const fixture = await handoffFixture({
    generate: async () => {
      generationStarted.resolve();
      await finishGeneration.promise;
      throw new Error("Name generation failed");
    },
  });
  fixture.autoName.scheduleForWorktree({
    workspace: fixture.workspace,
    firstAgentContext: { prompt: "Name this workspace" },
  });
  await generationStarted.promise;
  try {
    await fixture.ownership.prepare(fixture.transfer);
    await expect(
      fixture.ownership.markReady(fixture.transfer.id, "a".repeat(64)),
    ).rejects.toMatchObject({ code: "invalid_state" });
  } finally {
    finishGeneration.resolve();
  }
  await fixture.ownership.drain(fixture.transfer.id);
  await expect.poll(() => fixture.events).toEqual(["failed"]);
  expect(fixture.errors).toEqual(["Name generation failed"]);
  expect(fixture.branch()).toBe("placeholder");
  expect((await fixture.ownership.markReady(fixture.transfer.id, "a".repeat(64))).state).toBe(
    "ready",
  );
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("auto-name preserves workspace archival that lands during its metadata write", async () => {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-auto-name",
    projectId: "project-auto-name",
    cwd: "/workspace",
    kind: "directory",
    displayName: "workspace",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  const mutationStarted = deferred();
  const allowMutation = deferred();
  const updateEmitted = deferred();
  const workspaceRegistry = {
    update: async (_workspaceId, updater) => {
      mutationStarted.resolve();
      await allowMutation.promise;
      workspace = updater(workspace);
      return workspace;
    },
  } satisfies Pick<WorkspaceRegistry, "update">;
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry,
    workspaceGitService: {} as WorkspaceGitService,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => updateEmitted.resolve(),
    logger: pino({ level: "silent" }),
    generateWorkspaceName: async () => ({ title: "generated", branch: null }),
  });

  autoName.scheduleForDirectory({
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    firstAgentContext: { prompt: "Name this workspace" },
  });
  await mutationStarted.promise;
  const archivedAt = "2026-08-08T00:01:00.000Z";
  workspace = { ...workspace, updatedAt: archivedAt, archivedAt };
  allowMutation.resolve();
  await updateEmitted.promise;

  expect(workspace).toMatchObject({
    title: "generated",
    archivedAt,
  });
});

test("the first agent reuses the workspace generation for its title", async () => {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-agent-title",
    projectId: "project-agent-title",
    cwd: "/workspace",
    kind: "directory",
    displayName: "workspace",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  const workspaceRegistry = {
    update: async (_workspaceId, updater) => {
      workspace = updater(workspace);
      return workspace;
    },
  } satisfies Pick<WorkspaceRegistry, "update">;
  let generationCalls = 0;
  const titleReplaced = deferred();
  const replacements: Array<{ agentId: string; expected: string; next: string }> = [];
  const agentManager = {
    replaceTitleIfUnchanged: async (agentId: string, expected: string, next: string) => {
      replacements.push({ agentId, expected, next });
      titleReplaced.resolve();
      return true;
    },
  } as unknown as AgentManager;
  const workspaceUpdated = deferred();
  const autoName = new WorkspaceAutoName({
    agentManager,
    workspaceRegistry,
    workspaceGitService: {} as WorkspaceGitService,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => workspaceUpdated.resolve(),
    logger: pino({ level: "silent" }),
    generateWorkspaceName: async () => {
      generationCalls += 1;
      return { title: "Fix Safari login bug", branch: "fix-safari-login" };
    },
  });
  const firstAgentContext = { prompt: "fix the login bug on safari" };

  autoName.scheduleForDirectory({
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    firstAgentContext,
  });
  autoName.scheduleForAgent({
    agentId: "agent-1",
    cwd: workspace.cwd,
    firstAgentContext,
    provisionalTitle: "fix the login bug on safari",
  });
  await Promise.all([workspaceUpdated.promise, titleReplaced.promise]);

  expect(generationCalls).toBe(1);
  expect(workspace.title).toBe("Fix Safari login bug");
  expect(replacements).toEqual([
    { agentId: "agent-1", expected: "fix the login bug on safari", next: "Fix Safari login bug" },
  ]);
});
