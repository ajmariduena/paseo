import { expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { AgentManager, type AgentManagerEvent, type AgentSubscriber } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  CreateAgentLifecycleDispatch,
  registerAgentAutoArchive,
} from "./create-agent-lifecycle-dispatch.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { createWorktree } from "../../utils/worktree.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { ForgeService } from "../../services/forge-service.js";

class AgentLifecycleEvents {
  private readonly listeners = new Set<AgentSubscriber>();

  subscribe(listener: AgentSubscriber): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  completeTurn(agentId: string): void {
    const event: AgentManagerEvent = {
      type: "agent_stream",
      agentId,
      event: { type: "turn_completed", provider: "codex" },
    };
    for (const listener of this.listeners) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

test("auto-archive self-releases once and later cancellation waits harmlessly", async () => {
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e3";
  const agents = new AgentLifecycleEvents();
  let archiveCount = 0;
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      archiveCount += 1;
    },
  });

  agents.completeTurn(agentId);
  await registration.cancel();
  await registration.cancel();
  agents.completeTurn(agentId);

  expect(archiveCount).toBe(1);
  expect(agents.listenerCount()).toBe(0);
});

test.skipIf(process.platform === "win32").each(["agent-only", "created-worktree"] as const)(
  "%s auto-archive keeps a retained conversation visible after its turn finishes",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "retained-agent-lifecycle-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    await mkdir(repo);
    await writeFile(join(repo, "work.txt"), "Keep this work");
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git(["init", "--initial-branch=main"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "Initial work",
    ]);
    const logger = createTestLogger();
    const storage = new AgentStorage(join(home, "agents"), logger);
    await storage.initialize();
    const manager = new AgentManager({
      logger,
      registry: storage,
      clients: createTestAgentClients(),
    });
    let agentId: string | undefined;
    try {
      const worktree =
        kind === "created-worktree"
          ? await createWorktree({
              cwd: repo,
              paseoHome: home,
              worktreeSlug: "retained-job",
              runSetup: false,
              source: { kind: "branch-off", baseBranch: "main", branchName: "retained-job" },
            })
          : null;
      const cwd = worktree?.worktreePath ?? repo;
      const registry = new FileBackedWorkspaceRegistry(
        join(home, "projects", "workspaces.json"),
        logger,
      );
      const workspace = createPersistedWorkspaceRecord({
        workspaceId: "retained",
        projectId: "project",
        cwd,
        kind: worktree ? "worktree" : "directory",
        worktreeRoot: worktree?.worktreePath,
        mainRepoRoot: worktree ? repo : null,
        isPaseoOwnedWorktree: Boolean(worktree),
        displayName: "Retained job",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await registry.upsert(workspace);
      const agent = await manager.createAgent({ provider: "claude", cwd }, undefined, {
        workspaceId: workspace.workspaceId,
      });
      agentId = agent.id;
      const archiveAgentForClose = vi.fn((id: string) => manager.archiveAgent(id));
      const emitAgentRemove = vi.fn(async () => {});
      const lifecycle = new CreateAgentLifecycleDispatch({
        paseoHome: home,
        agentManager: manager,
        agentStorage: storage,
        logger,
        github: { invalidate() {} } as unknown as ForgeService,
        workspaceGitService: createNoopWorkspaceGitService(),
        createPaseoWorktreeWorkflow: async () => {
          throw new Error("Unexpected new worktree");
        },
        archiveAgentForClose,
        emitAgentRemove,
        findWorkspaceIdForCwd: async () => workspace.workspaceId,
        listActiveWorkspaces: async () =>
          (await registry.list()).filter((record) => !record.archivedAt),
        archiveWorkspaceRecord: (id) => registry.archive(id, new Date().toISOString()),
        emit() {},
        emitWorkspaceUpdatesForWorkspaceIds: async () => {},
        markWorkspaceArchiving() {},
        clearWorkspaceArchiving() {},
        killTerminalsForWorkspace: async () => {},
      });
      const createdWorktree: CreatePaseoWorktreeWorkflowResult | null = worktree
        ? {
            workspace,
            worktree,
            repoRoot: repo,
            created: true,
            intent: { kind: "branch-off", baseBranch: "main", branchName: worktree.branchName },
          }
        : null;
      const registration = lifecycle.registerAutoArchiveIfRequested({
        autoArchive: true,
        agentId,
        createdWorktree,
      });
      await registry.retainForHandoff({
        workspaceId: workspace.workspaceId,
        expectedIncarnation: workspace.incarnation!,
        transferId: randomUUID(),
        retainedAt: new Date().toISOString(),
      });
      await manager.runAgent(agentId, "Finish this retained task");
      await registration.cancel();
      expect(archiveAgentForClose).not.toHaveBeenCalled();
      expect(emitAgentRemove).not.toHaveBeenCalled();
      expect((await registry.get(workspace.workspaceId))?.archivedAt).toBeNull();
      expect((await storage.get(agentId))?.archivedAt).toBeUndefined();
      expect(await readFile(join(cwd, "work.txt"), "utf8")).toBe("Keep this work");
    } finally {
      if (agentId) await manager.closeAgent(agentId);
      await manager.flush();
      await rm(root, { recursive: true, force: true });
    }
  },
);
