import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createAgentCommand } from "../agent/create-agent/create.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createWorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { resolveWorkspaceIdForPath } from "../resolve-workspace-id-for-path.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import {
  type PersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { archiveByScope, type ActiveWorkspaceRef } from "../workspace-archive-service.js";
import {
  ScheduleService,
  ScheduleTargetGoneError,
  type ScheduleServiceOptions,
} from "./service.js";
import { ScheduleStore } from "./store.js";
import * as atomicFile from "../atomic-file.js";
import { randomUUID } from "node:crypto";
import { HandoffOwnership, HandoffOwnershipError } from "../handoff/ownership.js";
import type { ScheduleExecutionResult, StoredSchedule } from "@getpaseo/protocol/schedule/types";

interface ScheduleServiceInternals {
  executeSchedule(schedule: StoredSchedule, runId: string): Promise<ScheduleExecutionResult>;
}

const SCHEDULE_TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

const NO_UNATTENDED_SCHEDULE_POLICY: Pick<ProviderSnapshotManager, "resolveCreateConfig"> = {
  async resolveCreateConfig(input) {
    return {
      modeId: input.unattended ? input.requestedMode : "interactive",
      featureValues: input.featureValues,
    };
  },
};

const TEST_CLAUDE_PROVIDER_DEFINITION = {
  enabled: true,
};

let workspaceArchiveInProgress = false;

type TestScheduleServiceOptions = Omit<
  ScheduleServiceOptions,
  | "createAgent"
  | "createDirectoryWorkspace"
  | "createPaseoWorktreeWorkspace"
  | "archiveWorkspace"
  | "handoffOwnership"
  | "isHandoffIdentityVisible"
> & {
  handoffOwnership?: HandoffOwnership;
  isHandoffIdentityVisible?: (id: string) => boolean;
  agentManager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  createAgent?: ScheduleServiceOptions["createAgent"];
  createDirectoryWorkspace?: ScheduleServiceOptions["createDirectoryWorkspace"];
  createPaseoWorktreeWorkspace?: ScheduleServiceOptions["createPaseoWorktreeWorkspace"];
  archiveWorkspace?: ScheduleServiceOptions["archiveWorkspace"];
};

function createScheduleService(options: TestScheduleServiceOptions): ScheduleService {
  let workspaceCounter = 0;
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const workspaceGitService = createNoopWorkspaceGitService();
  const createDefaultWorkspace: ScheduleServiceOptions["createDirectoryWorkspace"] = async (
    input,
  ) => {
    const timestamp = new Date().toISOString();
    const workspaceId = `wks_schedule_test_${++workspaceCounter}`;
    const workspace: PersistedWorkspaceRecord = {
      workspaceId,
      projectId: "test-project",
      cwd: input.cwd,
      kind: "directory",
      displayName: "test-project",
      title: input.firstAgentContext.prompt,
      branch: null,
      baseBranch: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
    workspaces.set(workspaceId, workspace);
    return workspace;
  };
  const listActiveWorkspaces = async (): Promise<ActiveWorkspaceRef[]> =>
    Array.from(workspaces.values())
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
      }));
  const archiveDefaultWorkspace: ScheduleServiceOptions["archiveWorkspace"] = async (
    workspaceId,
  ) => {
    workspaceArchiveInProgress = true;
    try {
      await archiveByScope(
        {
          github: { invalidate: () => {} } as never,
          workspaceGitService,
          agentManager: options.agentManager,
          agentStorage: options.agentStorage,
          findWorkspaceIdForCwd: async (cwd) =>
            Array.from(workspaces.values()).find((workspace) => workspace.cwd === cwd)
              ?.workspaceId ?? null,
          listActiveWorkspaces,
          archiveWorkspaceRecord: async (id) => {
            const workspace = workspaces.get(id);
            if (workspace) {
              workspaces.set(id, { ...workspace, archivedAt: new Date().toISOString() });
            }
          },
          emitWorkspaceUpdatesForWorkspaceIds: async () => {},
          markWorkspaceArchiving: () => {},
          clearWorkspaceArchiving: () => {},
          killTerminalsForWorkspace: async () => {},
          sessionLogger: options.logger,
        },
        {
          scope: { kind: "workspace", workspaceId },
          requestId: "schedule-service-test",
        },
      );
    } finally {
      workspaceArchiveInProgress = false;
    }
  };
  return new ScheduleService({
    ...options,
    handoffOwnership: options.handoffOwnership ?? null,
    isHandoffIdentityVisible: options.isHandoffIdentityVisible ?? (() => true),
    createAgent:
      options.createAgent ??
      ((input) =>
        createAgentCommand(
          {
            agentManager: options.agentManager,
            agentStorage: options.agentStorage,
            logger: options.logger,
            providerSnapshotManager: options.providerSnapshotManager as ProviderSnapshotManager,
          },
          input,
        )),
    createDirectoryWorkspace: options.createDirectoryWorkspace ?? createDefaultWorkspace,
    createPaseoWorktreeWorkspace:
      options.createPaseoWorktreeWorkspace ??
      (async (input) => {
        const workspace = await createDefaultWorkspace(input);
        return {
          workspace,
          worktree: { branchName: "schedule-test", worktreePath: workspace.cwd },
          intent: { kind: "branch-off", baseBranch: "main", branchName: "schedule-test" },
          repoRoot: workspace.cwd,
          created: true,
        };
      }),
    archiveWorkspace: options.archiveWorkspace ?? archiveDefaultWorkspace,
  });
}

async function createRegistryBackedScheduleWorkspaceDeps(rootDir: string): Promise<{
  workspaceRegistry: FileBackedWorkspaceRegistry;
  createDirectoryWorkspace: ScheduleServiceOptions["createDirectoryWorkspace"];
  createArchiveWorkspace: (input: {
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    logger?: ScheduleServiceOptions["logger"];
  }) => ScheduleServiceOptions["archiveWorkspace"];
}> {
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    join(rootDir, "projects", "workspaces.json"),
    createTestLogger(),
  );
  const projectRegistry = new FileBackedProjectRegistry(
    join(rootDir, "projects", "projects.json"),
    createTestLogger(),
  );
  await workspaceRegistry.initialize();
  await projectRegistry.initialize();
  const workspaceGitService = createNoopWorkspaceGitService();
  const workspaceProvisioning = createWorkspaceProvisioningService({
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    isDirectory: async () => true,
  });
  return {
    workspaceRegistry,
    createDirectoryWorkspace: async (input) => {
      return workspaceProvisioning.createWorkspaceForDirectory(
        input.cwd,
        input.firstAgentContext.prompt,
      );
    },
    createArchiveWorkspace:
      ({ agentManager, agentStorage, logger = createTestLogger() }) =>
      async (workspaceId) => {
        workspaceArchiveInProgress = true;
        try {
          await archiveByScope(
            {
              github: { invalidate: () => {} } as never,
              workspaceGitService,
              agentManager,
              agentStorage,
              findWorkspaceIdForCwd: async (cwd) =>
                resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list()),
              listActiveWorkspaces: async () =>
                (await workspaceRegistry.list())
                  .filter((workspace) => !workspace.archivedAt)
                  .map((workspace) => ({
                    workspaceId: workspace.workspaceId,
                    cwd: workspace.cwd,
                    kind: workspace.kind,
                  })),
              archiveWorkspaceRecord: async (id) => {
                await workspaceRegistry.archive(id, new Date().toISOString());
              },
              emitWorkspaceUpdatesForWorkspaceIds: async () => {},
              markWorkspaceArchiving: () => {},
              clearWorkspaceArchiving: () => {},
              killTerminalsForWorkspace: async () => {},
              sessionLogger: logger,
            },
            {
              scope: { kind: "workspace", workspaceId },
              requestId: "schedule-service-test",
            },
          );
        } finally {
          workspaceArchiveInProgress = false;
        }
      },
  };
}

function buildAgentRecord(params: {
  id: string;
  cwd: string;
  iso: string;
  archivedAt?: string | null;
}) {
  return {
    id: params.id,
    provider: "claude",
    cwd: params.cwd,
    createdAt: params.iso,
    updatedAt: params.iso,
    lastActivityAt: params.iso,
    lastUserMessageAt: null,
    title: params.id,
    labels: {},
    lastStatus: "closed" as const,
    lastModeId: "default",
    config: { modeId: "default" },
    runtimeInfo: null,
    features: [],
    persistence: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: params.archivedAt ?? null,
  };
}

describe("ScheduleService", () => {
  let tempDir: string;
  let agentStorage: AgentStorage;
  let now: Date;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schedule-service-test-"));
    await mkdir(join(tempDir, "agents"), { recursive: true });
    agentStorage = new AgentStorage(join(tempDir, "agents"), createTestLogger());
    await agentStorage.initialize();
    now = new Date("2026-01-01T00:00:00.000Z");
  });

  afterEach(async () => {
    // Drain pending background persists before deleting the dir to avoid
    // ENOTEMPTY races when AgentManager flushes a snapshot mid-cleanup.
    await agentStorage.flush();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function handoffFixture(runner?: ScheduleServiceOptions["runner"]) {
    const ownership = new HandoffOwnership({
      directory: join(tempDir, "handoff"),
      sourceServerId: "source",
    });
    await ownership.initialize();
    const cwd = join(tempDir, "moving");
    const otherCwd = join(tempDir, "other");
    await mkdir(cwd);
    await mkdir(otherCwd);
    const options: TestScheduleServiceOptions = {
      paseoHome: tempDir,
      handoffOwnership: ownership,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner,
    };
    const service = createScheduleService(options);
    const schedule = await service.create({
      prompt: "Check progress",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd } },
    });
    const transfer = {
      id: randomUUID(),
      cwd,
      workspaceId: "moving",
      agentIds: [],
      destinationServerId: "destination",
      reservationId: randomUUID(),
    };
    return { ownership, service, schedule, transfer, otherCwd, options };
  }

  test.skipIf(process.platform === "win32")(
    "handoff binds an active heartbeat and drains its durable outcome before paused capture",
    async () => {
      const { ownership, transfer } = await handoffFixture();
      const manager = new AgentManager({
        logger: createTestLogger(),
        clients: createTestAgentClients(),
        registry: agentStorage,
      });
      const agent = await manager.createAgent(
        { provider: "claude", cwd: transfer.cwd },
        undefined,
        { workspaceId: transfer.workspaceId },
      );
      transfer.agentIds.push(agent.id);
      const session = manager.getAgent(agent.id)?.session;
      if (!session) throw new Error("Missing test session");
      vi.spyOn(session, "startTurn").mockResolvedValue({ turnId: "held-heartbeat" });
      const waiting = Promise.withResolvers<void>();
      const wait = manager.waitForAgentEvent.bind(manager);
      vi.spyOn(manager, "waitForAgentEvent").mockImplementation((id, options) => {
        const result = wait(id, options);
        waiting.resolve();
        return result;
      });
      const options = {
        paseoHome: tempDir,
        handoffOwnership: ownership,
        logger: createTestLogger(),
        agentManager: manager,
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
      };
      const service = createScheduleService(options);
      const heartbeat = await service.create({
        prompt: "Continue",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "agent", agentId: agent.id },
      });
      const running = service.runOnce(heartbeat.id);
      const outcomeStarted = Promise.withResolvers<void>();
      const finishOutcome = Promise.withResolvers<void>();
      const sync = atomicFile.syncFilePublication;
      const publication = vi
        .spyOn(atomicFile, "syncFilePublication")
        .mockImplementation(async (...args) => {
          if (args[0].endsWith(`${heartbeat.id}.json`)) {
            outcomeStarted.resolve();
            await finishOutcome.promise;
          }
          return sync(...args);
        });
      try {
        await waiting.promise;
        const schedules = await service.reviewForHandoff(transfer);
        const review = schedules.find((entry) => entry.id === heartbeat.id);
        expect(review?.activeRun).toEqual({
          id: (await service.logs(heartbeat.id))[0].id,
          previousLastRunAt: null,
        });
        expect(await service.estimateForHandoff(transfer)).toBeGreaterThan(0);
        await expect(createScheduleService(options).reviewForHandoff(transfer)).rejects.toThrow(
          "cannot be stopped by this handoff",
        );
        await expect(
          service.reviewForHandoff({
            ...transfer,
            stoppedWorkReview: {
              agents: [],
              terminals: [],
              setupIds: [],
              schedules: schedules.map((entry) => ({
                ...entry,
                ...(entry.activeRun ? { activeRun: { ...entry.activeRun, id: randomUUID() } } : {}),
              })),
            },
          }),
        ).rejects.toThrow("execution changed after review");
        const source = await ownership.prepare({
          ...transfer,
          stoppedWorkReview: { agents: [], terminals: [], setupIds: [], schedules },
        });
        await expect(service.exportForHandoff(source)).rejects.toThrow("still active");
        await manager.closeAgent(agent.id);
        await outcomeStarted.promise;
        await expect(ownership.markReady(source.id, "a".repeat(64))).rejects.toThrow(
          "still running",
        );
        finishOutcome.resolve();
        await running;
        await ownership.drain(source.id);
        await service.pauseForHandoff(source);
        const captured = await service.exportForHandoff(source);
        const imported = captured.schedules.find((entry) => entry.id === heartbeat.id);
        expect(imported).toMatchObject({
          reviewDigest: review?.digest,
          status: "paused",
          runs: [
            {
              agentId: agent.id,
              status: "failed",
              error: `Scheduled agent ${agent.id} was canceled`,
            },
          ],
        });
        const restarted = createScheduleService(options);
        expect(await restarted.exportForHandoff(source)).toEqual(captured);
        await restarted.pauseForHandoff(source);
        await ownership.cancel(source.id);
        expect((await restarted.inspect(heartbeat.id)).status).toBe("paused");
      } finally {
        finishOutcome.resolve();
        publication.mockRestore();
        await manager.closeAgent(agent.id);
        await running;
        await manager.flush();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff automation pause survives retries, cancellation and restart until explicit resume",
    async () => {
      const runner = vi.fn(async () => ({ agentId: null, output: "resumed" }));
      const { ownership, service, schedule, transfer, options } = await handoffFixture(runner);
      const schedules = await service.reviewForHandoff(transfer);
      const source = await ownership.prepare({
        ...transfer,
        stoppedWorkReview: { agents: [], terminals: [], setupIds: [], schedules },
      });
      await service.pauseForHandoff(source);
      const captured = await service.exportForHandoff(source);
      expect(captured.schedules).toMatchObject([
        { id: schedule.id, status: "paused", nextRunAt: null, reviewDigest: schedules[0].digest },
      ]);
      now = new Date(now.getTime() + 60_000);
      await service.pauseForHandoff(source);
      expect(await service.exportForHandoff(source)).toEqual(captured);
      await ownership.cancel(transfer.id);
      const restartedOwnership = new HandoffOwnership({
        directory: join(tempDir, "handoff"),
        sourceServerId: "source",
      });
      await restartedOwnership.initialize();
      const restarted = createScheduleService({ ...options, handoffOwnership: restartedOwnership });
      try {
        await restarted.start();
        await restarted.tick();
        expect(runner).not.toHaveBeenCalled();
        expect(await restarted.exportForHandoff(transfer)).toEqual(captured);
        await restarted.resume(schedule.id);
        now = new Date(now.getTime() + 60_000);
        await restarted.tick();
        expect(runner).toHaveBeenCalledTimes(1);
      } finally {
        await restarted.stop();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff refuses changed automation review without pausing unreviewed work",
    async () => {
      const { ownership, service, schedule, transfer } = await handoffFixture();
      const schedules = await service.reviewForHandoff(transfer);
      await service.update({ id: schedule.id, prompt: "Changed instructions" });
      const source = await ownership.prepare({
        ...transfer,
        stoppedWorkReview: { agents: [], terminals: [], setupIds: [], schedules },
      });
      await expect(service.pauseForHandoff(source)).rejects.toThrow("changed after handoff review");
      expect((await service.inspect(schedule.id)).status).toBe("active");
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff requires a complete automation inventory and refuses running jobs",
    async () => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const { service, schedule, transfer } = await handoffFixture(async () => {
        entered.resolve();
        await finish.promise;
        return { agentId: null, output: "done" };
      });
      const run = service.runOnce(schedule.id);
      await entered.promise;
      try {
        await expect(service.reviewForHandoff(transfer)).rejects.toThrow("still active");
      } finally {
        finish.resolve();
        await run;
      }
      await writeFile(join(tempDir, "schedules", "broken.json"), "not json");
      await expect(service.reviewForHandoff(transfer)).rejects.toThrow();
      expect((await service.inspect(schedule.id)).status).toBe("active");
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff refuses ancestor schedules and external heartbeat targets sharing the checkout",
    async () => {
      const { service, transfer } = await handoffFixture();
      const ancestor = await service.create({
        prompt: "Parent work",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      });
      await expect(service.reviewForHandoff(transfer)).rejects.toThrow("ancestor");
      await service.delete(ancestor.id);
      const agentId = randomUUID();
      await agentStorage.upsert({
        id: agentId,
        provider: "claude",
        cwd: transfer.cwd,
        workspaceId: "other-workspace",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastStatus: "closed",
        labels: {},
      });
      await service.create({
        prompt: "External work",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "agent", agentId },
      });
      await expect(service.reviewForHandoff(transfer)).rejects.toThrow("another conversation");
    },
  );

  test.skipIf(process.platform === "win32").each(["succeeded", "failed"] as const)(
    "handoff repairs a %s schedule outcome without replacing it with a storage failure or rerunning work",
    async (status) => {
      const runner = vi.fn(async () => {
        if (status === "failed") throw new Error("Actual execution failure");
        return { agentId: null, output: "Only copy of the completed result" };
      });
      const { service, schedule, transfer } = await handoffFixture(runner);
      const write = atomicFile.writeJsonFileAtomic;
      const failedWrite = vi
        .spyOn(atomicFile, "writeJsonFileAtomic")
        .mockImplementation(async (file, value) => {
          const parsed = value as StoredSchedule;
          if (file.endsWith(`${schedule.id}.json`) && parsed.runs[0]?.status === status)
            throw new Error("outcome publication unavailable");
          return write(file, value);
        });
      try {
        await expect(service.runOnce(schedule.id)).rejects.toThrow(
          "outcome publication unavailable",
        );
        await expect(service.reviewForHandoff(transfer)).rejects.toThrow(
          "outcome publication unavailable",
        );
      } finally {
        failedWrite.mockRestore();
      }
      const review = await service.reviewForHandoff(transfer);
      expect(review).toHaveLength(1);
      const saved = await service.inspect(schedule.id);
      expect(saved.runs).toMatchObject([
        {
          status,
          output: status === "succeeded" ? "Only copy of the completed result" : null,
          error: status === "failed" ? "Actual execution failure" : null,
        },
      ]);
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff waits for an admitted schedule outcome and preserves it after fencing",
    async () => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const { ownership, service, schedule, transfer, otherCwd } = await handoffFixture(
        async () => {
          entered.resolve();
          await finish.promise;
          return { agentId: null, output: "Saved result" };
        },
      );
      const run = service.runOnce(schedule.id);
      await entered.promise;
      await expect(
        service.update({ id: schedule.id, newAgentConfig: { cwd: otherCwd } }),
      ).rejects.toThrow("while a run is active");
      await expect(service.runOnce(schedule.id)).rejects.toThrow("already running");
      await ownership.prepare(transfer);
      try {
        await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toThrow(
          "still running",
        );
      } finally {
        finish.resolve();
      }
      const result = await run;
      await ownership.drain(transfer.id);
      expect(result.runs).toMatchObject([{ status: "succeeded", output: "Saved result" }]);
      await expect(ownership.markReady(transfer.id, "a".repeat(64))).resolves.toMatchObject({
        state: "ready",
      });
    },
  );

  test.skipIf(process.platform === "win32").each(["pause", "retarget"] as const)(
    "handoff rechecks a stale scheduler snapshot after %s",
    async (action) => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const runner = vi.fn(async () => {
        entered.resolve();
        await finish.promise;
        return { agentId: null, output: "done" };
      });
      const { ownership, service, transfer, otherCwd } = await handoffFixture(runner);
      now = new Date(now.getTime() + 1);
      const later = await service.create({
        prompt: "Later schedule",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: otherCwd } },
      });
      const tick = service.tick();
      await entered.promise;
      try {
        if (action === "pause") await service.pause(later.id);
        else await service.update({ id: later.id, newAgentConfig: { cwd: transfer.cwd } });
        await ownership.prepare(transfer);
      } finally {
        finish.resolve();
      }
      await tick;
      expect(runner).toHaveBeenCalledTimes(1);
      expect((await service.inspect(later.id)).runs).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff guards both old and new schedule targets, including symlinks",
    async () => {
      const { ownership, service, schedule, transfer, otherCwd } = await handoffFixture();
      const outside = await service.create({
        prompt: "Outside",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: otherCwd } },
      });
      const alias = join(tempDir, "alias");
      await symlink(transfer.cwd, alias, "dir");
      await ownership.prepare(transfer);
      await expect(
        service.update({ id: schedule.id, newAgentConfig: { cwd: otherCwd } }),
      ).rejects.toMatchObject({ code: "fenced" });
      await expect(
        service.update({ id: outside.id, newAgentConfig: { cwd: alias } }),
      ).rejects.toMatchObject({ code: "fenced" });
      await expect(
        service.create({
          prompt: "Alias",
          cadence: outside.cadence,
          target: { type: "new-agent", config: { provider: "claude", cwd: alias } },
        }),
      ).rejects.toMatchObject({ code: "fenced" });
      expect(await service.inspect(schedule.id)).toEqual(schedule);
      expect(await service.inspect(outside.id)).toEqual(outside);
      await ownership.markReady(transfer.id, "a".repeat(64));
      await expect(service.pause(outside.id)).resolves.toMatchObject({ status: "paused" });
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff schedule admission propagates uncertain storage instead of skipping it",
    async () => {
      const runner = vi.fn(async () => ({ agentId: null, output: "unexpected" }));
      const { ownership, service, schedule } = await handoffFixture(runner);
      const admission = vi
        .spyOn(ownership, "acquireMutation")
        .mockRejectedValue(new HandoffOwnershipError("storage_uncertain", "journal unavailable"));
      try {
        await expect(service.tick()).rejects.toThrow("journal unavailable");
        expect(await service.inspect(schedule.id)).toEqual(schedule);
        expect(runner).not.toHaveBeenCalled();
      } finally {
        admission.mockRestore();
      }
      await service.tick();
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff retains schedule admission through workspace cleanup with the real runner",
    async () => {
      const { ownership, schedule, transfer, options } = await handoffFixture();
      const cleanupEntered = Promise.withResolvers<void>();
      const finishCleanup = Promise.withResolvers<void>();
      const manager = new AgentManager({
        logger: createTestLogger(),
        clients: createTestAgentClients(),
        registry: agentStorage,
      });
      const service = createScheduleService({
        ...options,
        agentManager: manager,
        archiveWorkspace: async () => {
          cleanupEntered.resolve();
          await finishCleanup.promise;
        },
      });
      const run = service.runOnce(schedule.id);
      await cleanupEntered.promise;
      await ownership.prepare(transfer);
      try {
        await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toThrow(
          "still running",
        );
      } finally {
        finishCleanup.resolve();
      }
      const result = await run;
      expect(result.runs).toMatchObject([
        { status: "succeeded", workspaceId: "wks_schedule_test_1", agentId: expect.any(String) },
      ]);
      await ownership.drain(transfer.id);
      await ownership.markReady(transfer.id, "a".repeat(64));
      await manager.closeAgent(result.runs[0].agentId!);
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff keeps a released heartbeat fenced after its agent record is removed",
    async () => {
      const { ownership, service, transfer, options } = await handoffFixture();
      const agentId = randomUUID();
      await agentStorage.upsert({
        id: agentId,
        cwd: transfer.cwd,
        workspaceId: transfer.workspaceId,
        provider: "claude",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastStatus: "closed",
        labels: {},
      });
      const heartbeat = await service.create({
        prompt: "Continue",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "agent", agentId },
      });
      await ownership.prepare({ ...transfer, agentIds: [agentId] });
      const manifestDigest = "a".repeat(64);
      await ownership.markReady(transfer.id, manifestDigest);
      await ownership.release(
        transfer.id,
        {
          version: 1,
          transferId: transfer.id,
          sourceServerId: "source",
          destinationServerId: transfer.destinationServerId,
          reservationId: transfer.reservationId,
          manifestDigest,
        },
        async () => {},
      );
      await agentStorage.remove(agentId);
      const restartedOwnership = new HandoffOwnership({
        directory: join(tempDir, "handoff"),
        sourceServerId: "source",
      });
      await restartedOwnership.initialize();
      const restarted = createScheduleService({ ...options, handoffOwnership: restartedOwnership });
      try {
        await restarted.start();
        await restarted.tick();
        await expect(restarted.resume(heartbeat.id)).rejects.toMatchObject({ code: "fenced" });
        await expect(restarted.runOnce(heartbeat.id)).rejects.toMatchObject({ code: "fenced" });
        expect(await restarted.inspect(heartbeat.id)).toEqual(heartbeat);
      } finally {
        await restarted.stop();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff restart leaves fenced schedule recovery and expiration untouched",
    async () => {
      const { ownership, service, schedule, transfer, options } = await handoffFixture();
      const interrupted = await new ScheduleStore(
        join(tempDir, "schedules"),
        createTestLogger(),
      ).update(schedule.id, (current) => ({
        ...current,
        expiresAt: now.toISOString(),
        runs: [
          {
            id: randomUUID(),
            scheduledFor: now.toISOString(),
            startedAt: now.toISOString(),
            endedAt: null,
            status: "running",
            agentId: null,
            workspaceId: "interrupted-workspace",
            output: null,
            error: null,
          },
        ],
      }));
      await ownership.prepare(transfer);
      const restartedOwnership = new HandoffOwnership({
        directory: join(tempDir, "handoff"),
        sourceServerId: "source",
      });
      await restartedOwnership.initialize();
      const archiveWorkspace = vi.fn(async () => {});
      const restarted = createScheduleService({
        ...options,
        handoffOwnership: restartedOwnership,
        archiveWorkspace,
      });
      try {
        await restarted.start();
        await restarted.tick();
        expect(await service.inspect(schedule.id)).toEqual(interrupted);
        expect(archiveWorkspace).not.toHaveBeenCalled();
      } finally {
        await restarted.stop();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff skips fenced schedules without consuming a run and continues unrelated work",
    async () => {
      const ownership = new HandoffOwnership({
        directory: join(tempDir, "handoff"),
        sourceServerId: "source",
      });
      await ownership.initialize();
      const cwd = join(tempDir, "moving");
      const otherCwd = join(tempDir, "other");
      await mkdir(cwd);
      await mkdir(otherCwd);
      const runner = vi.fn(async () => ({ agentId: null, output: "finished" }));
      const service = createScheduleService({
        paseoHome: tempDir,
        handoffOwnership: ownership,
        logger: createTestLogger(),
        agentManager: new AgentManager({ logger: createTestLogger() }),
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
        runner,
      });
      const moving = await service.create({
        prompt: "Review moving workspace",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd } },
        maxRuns: 1,
      });
      const other = await service.create({
        prompt: "Review unrelated workspace",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: otherCwd } },
      });
      await ownership.prepare({
        id: randomUUID(),
        cwd,
        workspaceId: "moving",
        agentIds: [],
        destinationServerId: "destination",
        reservationId: randomUUID(),
      });
      await service.tick();
      expect(await service.inspect(moving.id)).toEqual(moving);
      expect(runner).toHaveBeenCalledTimes(1);
      expect((await service.inspect(other.id)).runs).toMatchObject([{ status: "succeeded" }]);
      await expect(service.runOnce(moving.id)).rejects.toMatchObject({ code: "fenced" });
      expect(await service.inspect(moving.id)).toEqual(moving);
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff fences schedule controls and heartbeat replacement through the store",
    async () => {
      const ownership = new HandoffOwnership({
        directory: join(tempDir, "handoff"),
        sourceServerId: "source",
      });
      await ownership.initialize();
      const agentId = randomUUID();
      await agentStorage.upsert({
        id: agentId,
        cwd: tempDir,
        workspaceId: "moving",
        provider: "claude",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastStatus: "closed",
        labels: {},
      });
      const service = createScheduleService({
        paseoHome: tempDir,
        handoffOwnership: ownership,
        logger: createTestLogger(),
        agentManager: new AgentManager({ logger: createTestLogger() }),
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
      });
      const input = {
        name: "Keep checking",
        prompt: "Check progress",
        cadence: { type: "every" as const, everyMs: 60_000 },
        target: { type: "agent" as const, agentId },
      };
      const heartbeat = await service.createOrReplace(input);
      await ownership.prepare({
        id: randomUUID(),
        cwd: tempDir,
        workspaceId: "moving",
        agentIds: [agentId],
        destinationServerId: "destination",
        reservationId: randomUUID(),
      });
      await expect(service.create(input)).rejects.toMatchObject({ code: "fenced" });
      await expect(service.createOrReplace(input)).rejects.toMatchObject({ code: "fenced" });
      await expect(service.pause(heartbeat.id)).rejects.toMatchObject({ code: "fenced" });
      await expect(service.resume(heartbeat.id)).rejects.toMatchObject({ code: "fenced" });
      await expect(service.update({ id: heartbeat.id, prompt: "Changed" })).rejects.toMatchObject({
        code: "fenced",
      });
      await expect(service.delete(heartbeat.id)).rejects.toMatchObject({ code: "fenced" });
      await expect(service.runOnce(heartbeat.id)).rejects.toMatchObject({ code: "fenced" });
      expect(await service.list()).toEqual([heartbeat]);
    },
  );

  test("ticks due schedules and records run history on disk", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async (schedule) => ({
        agentId: "00000000-0000-0000-0000-000000000001",
        output: `ran:${schedule.prompt}`,
      }),
    });

    const created = await service.create({
      prompt: "Review new PRs",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000001",
      output: "ran:Review new PRs",
    });
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("pause and resume update persisted schedule state", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({
        agentId: null,
        output: "ok",
      }),
    });

    const created = await service.create({
      prompt: "Check status",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();

    now = new Date("2026-01-01T00:03:00.000Z");
    const resumed = await service.resume(created.id);
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBe("2026-01-01T00:04:00.000Z");
  });

  test("completes schedules when max runs is reached", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({
        agentId: null,
        output: "done",
      }),
    });

    const created = await service.create({
      prompt: "One shot",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
  });

  test("executes new-agent schedules through AgentManager with real fake clients", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
    expect(inspected.runs[0]?.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("delivers agent-target schedules through the steer-or-interrupt path", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const agent = await manager.createAgent({ provider: "claude", cwd: tempDir }, undefined, {
      workspaceId: undefined,
    });
    const steerOrReplace = vi.spyOn(manager, "steerOrReplaceActiveTurn");
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });
    const schedule = await service.create({
      prompt: "Check scheduled work",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agent.id },
    });

    await service.runOnce(schedule.id);

    expect(steerOrReplace).toHaveBeenCalledTimes(1);
    expect(steerOrReplace.mock.calls[0]).toEqual([
      agent.id,
      expect.stringContaining(`Schedule fired (id=${schedule.id}, run=`),
      { clientMessageId: expect.stringContaining(`schedule:${schedule.id}:`) },
    ]);
  });

  test.each(["stop", "close"])(
    "records a heartbeat canceled by %s as failed instead of successful idle",
    async (action) => {
      const manager = new AgentManager({
        logger: createTestLogger(),
        clients: createTestAgentClients(),
        registry: agentStorage,
      });
      const agent = await manager.createAgent({ provider: "claude", cwd: tempDir }, undefined, {
        workspaceId: undefined,
      });
      const live = manager.getAgent(agent.id);
      if (!live?.session) throw new Error("Missing test provider session");
      // A held test-provider turn leaves cancellation to the real manager lifecycle.
      vi.spyOn(live.session, "startTurn").mockResolvedValue({ turnId: "heartbeat-turn" });
      const waiting = Promise.withResolvers<void>();
      const waitForAgentEvent = manager.waitForAgentEvent.bind(manager);
      vi.spyOn(manager, "waitForAgentEvent").mockImplementation((id, options) => {
        const result = waitForAgentEvent(id, options);
        waiting.resolve();
        return result;
      });
      const service = createScheduleService({
        paseoHome: tempDir,
        logger: createTestLogger(),
        agentManager: manager,
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
      });
      const schedule = await service.create({
        prompt: "Check scheduled work",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "agent", agentId: agent.id },
      });
      const running = service.runOnce(schedule.id);
      try {
        await waiting.promise;
        if (action === "close") await manager.closeAgent(agent.id);
        else await manager.cancelAgentRun(agent.id);
        await running;
        expect((await service.inspect(schedule.id)).runs).toEqual([
          expect.objectContaining({
            status: "failed",
            agentId: agent.id,
            output: null,
            error: `Scheduled agent ${agent.id} was canceled`,
          }),
        ]);
      } finally {
        await manager.closeAgent(agent.id);
        await running;
        await manager.flush();
      }
    },
  );

  test("titles scheduled new agents from the schedule prompt", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "Audit flaky checkout flow\n\nReport only blockers.",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.title).toBe("Audit flaky checkout flow");
  });

  test("new-agent schedule records create no workspace until run time", async () => {
    const { workspaceRegistry, createDirectoryWorkspace: createScheduleDirectoryWorkspace } =
      await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "server-owned workspace happens at run time",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      runOnCreate: false,
    });

    expect(created.target.config).toMatchObject({
      provider: "claude",
      model: "test-model",
      cwd: tempDir,
    });
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("archiveOnFinish=false local runs create one active workspace per run", async () => {
    const {
      workspaceRegistry,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      now: () => now,
    });

    const created = await service.create({
      prompt: "repeat in separate workspaces",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          archiveOnFinish: false,
          isolation: "local",
        },
      },
      maxRuns: 2,
    });

    await service.tick();
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(2);
    const firstAgent = await agentStorage.get(inspected.runs[0]!.agentId!);
    const secondAgent = await agentStorage.get(inspected.runs[1]!.agentId!);
    expect(firstAgent?.workspaceId).toMatch(/^wks_/);
    expect(secondAgent?.workspaceId).toMatch(/^wks_/);
    expect(firstAgent?.workspaceId).not.toBe(secondAgent?.workspaceId);
    expect(firstAgent?.archivedAt ?? null).toBeNull();
    expect(secondAgent?.archivedAt ?? null).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([
      expect.objectContaining({
        workspaceId: firstAgent?.workspaceId,
        cwd: tempDir,
        archivedAt: null,
      }),
      expect.objectContaining({
        workspaceId: secondAgent?.workspaceId,
        cwd: tempDir,
        archivedAt: null,
      }),
    ]);
  });

  test("archiveOnFinish=true archives the run workspace through workspace archive", async () => {
    const {
      workspaceRegistry,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const archiveAgent = manager.archiveAgent.bind(manager);
    manager.archiveAgent = async (agentId) => {
      if (!workspaceArchiveInProgress) {
        throw new Error("scheduled runs must archive workspaces, not agents directly");
      }
      return archiveAgent(agentId);
    };
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      now: () => now,
    });

    const created = await service.create({
      prompt: "archive the run workspace",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          isolation: "local",
        },
      },
      maxRuns: 1,
    });

    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]?.status).toBe("succeeded");
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.workspaceId).toMatch(/^wks_/);
    expect(storedAgent?.archivedAt).toEqual(expect.any(String));
    expect(await workspaceRegistry.get(storedAgent!.workspaceId!)).toEqual(
      expect.objectContaining({
        workspaceId: storedAgent?.workspaceId,
        archivedAt: expect.any(String),
      }),
    );
  });

  test("archives the run workspace when scheduled agent creation fails before archive opt-out can preserve an agent", async () => {
    const {
      workspaceRegistry,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const createError = new Error("provider misconfigured");
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      createAgent: async () => {
        throw createError;
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "fail before agent exists",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          archiveOnFinish: false,
          isolation: "local",
        },
      },
      runOnCreate: false,
    });

    await expect(
      (service as unknown as ScheduleServiceInternals).executeSchedule(created, "run-create-fails"),
    ).rejects.toThrow("provider misconfigured");

    expect(await workspaceRegistry.list()).toEqual([
      expect.objectContaining({
        cwd: tempDir,
        archivedAt: expect.any(String),
      }),
    ]);
  });

  test("new-agent cwd existence is checked at run time, not when editing the schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "missing cwd can be configured",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: join(tempDir, "does-not-exist") },
      },
      runOnCreate: false,
    });

    const updated = await service.update({
      id: created.id,
      newAgentConfig: { cwd: join(tempDir, "also-missing") },
    });

    expect(updated.target.config).toMatchObject({
      provider: "claude",
      cwd: join(tempDir, "also-missing"),
    });
  });

  test("concurrent run finish and update preserve the target config and run outcome", async () => {
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    const legacy = await store.create({
      name: null,
      prompt: "finish/update race",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: now.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        releaseRun?.();
        await runBlocked;
        return {
          agentId: null,
          output: "finished while updating",
        };
      },
    });

    const tickPromise = service.tick();
    await runStarted;
    const updatePromise = service.update({
      id: legacy.id,
      newAgentConfig: { modeId: "full-access" },
    });
    finishRun?.();
    await Promise.all([tickPromise, updatePromise]);

    const inspected = await service.inspect(legacy.id);
    expect(inspected.target).toMatchObject({
      type: "new-agent",
      config: {
        modeId: "full-access",
      },
    });
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      output: "finished while updating",
      error: null,
    });
  });

  test("scheduled new-agent slash prompts run as normal foreground prompts", async () => {
    const createdInputs: Parameters<ScheduleServiceOptions["createAgent"]>[0][] = [];
    const runPrompts: AgentPromptInput[] = [];
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async (_agentId, prompt) => {
      runPrompts.push(prompt);
      return {
        sessionId: "scheduled-slash-run",
        finalText: "compacted",
        timeline: [{ type: "assistant_message", text: "compacted" }],
      };
    };
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: "compacted",
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        createdInputs.push(input);
        const snapshot = {
          id: "00000000-0000-0000-0000-000000000322",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "/compact",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0].initialPrompt).toBeUndefined();
    expect(runPrompts).toEqual(["/compact"]);
    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      output: "compacted",
    });
  });

  test("scheduled new-agent run output falls back to final text and curated timeline", async () => {
    let runCount = 0;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => {
      runCount += 1;
      return runCount === 1
        ? {
            sessionId: "scheduled-final-text-run",
            finalText: "final text output",
            timeline: [],
          }
        : {
            sessionId: "scheduled-timeline-run",
            finalText: "",
            timeline: [{ type: "assistant_message", text: "timeline output" }],
          };
    };
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: null,
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id:
            runCount === 0
              ? "00000000-0000-0000-0000-000000000323"
              : "00000000-0000-0000-0000-000000000324",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const finalTextSchedule = await service.create({
      prompt: "final text",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    const timelineSchedule = await service.create({
      prompt: "timeline",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });

    await service.runOnce(finalTextSchedule.id);
    await service.runOnce(timelineSchedule.id);

    expect((await service.inspect(finalTextSchedule.id)).runs[0]?.output).toBe("final text output");
    expect((await service.inspect(timelineSchedule.id)).runs[0]?.output).toContain(
      "timeline output",
    );
  });

  test("scheduled new-agent cancellations fail the run", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => ({
      sessionId: "scheduled-canceled-run",
      finalText: "",
      timeline: [],
      canceled: true,
    });
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: null,
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id: "00000000-0000-0000-0000-000000000325",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "cancel me",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("was canceled"),
    });
  });

  test("failed new-agent run keeps run error when workspace archive also fails", async () => {
    const logger = createTestLogger();
    const warn = vi.fn();
    logger.warn = warn as typeof logger.warn;
    logger.child = (() => logger) as typeof logger.child;
    const archiveError = new Error("archive exploded");
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => {
      throw new Error("run exploded");
    };
    const agentId = "00000000-0000-0000-0000-000000000326";
    const service = createScheduleService({
      paseoHome: tempDir,
      logger,
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id: agentId,
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      archiveWorkspace: async () => {
        throw archiveError;
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "fail and fail cleanup",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      error: "run exploded",
      agentId,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: archiveError,
        agentId,
        workspaceId: expect.stringMatching(/^wks_/),
        scheduleId: created.id,
        runId: expect.any(String),
      }),
      expect.stringContaining("Failed to archive scheduled workspace"),
    );
  });

  test("shows scheduled new-agent prompts as normal user turns", async () => {
    class PromptEchoScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id = "scheduled-prompt-echo-session";
      private turnCount = 0;
      private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

      async run(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
        const turnId = `run-${++this.turnCount}`;
        const textPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        this.emit({ type: "turn_started", provider: this.provider, turnId });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "user_message", text: textPrompt },
        });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text: "done" },
        });
        this.emit({
          type: "turn_completed",
          provider: this.provider,
          turnId,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        return {
          sessionId: this.id,
          finalText: "done",
          timeline: [{ type: "assistant_message", text: "done" }],
        };
      }

      async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
        const turnId = `turn-${++this.turnCount}`;
        const textPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        setImmediate(() => {
          this.emit({ type: "turn_started", provider: this.provider, turnId });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "user_message", text: textPrompt },
          });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "assistant_message", text: "done" },
          });
          this.emit({
            type: "turn_completed",
            provider: this.provider,
            turnId,
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        });
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subscribers.add(callback);
        return () => {
          this.subscribers.delete(callback);
        };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return null;
      }

      async setMode(_modeId: string): Promise<void> {}

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(
        _requestId: string,
        _response: AgentPermissionResponse,
      ): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}

      private emit(event: AgentStreamEvent): void {
        for (const subscriber of this.subscribers) {
          subscriber(event);
        }
      }
    }

    class PromptEchoScheduleClient implements AgentClient {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;

      async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
        return new PromptEchoScheduleSession();
      }

      async resumeSession(_handle: AgentPersistenceHandle): Promise<AgentSession> {
        return new PromptEchoScheduleSession();
      }

      async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
        return { models: [], modes: [] };
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: { claude: new PromptEchoScheduleClient() },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });
    const observedUserMessages: string[] = [];
    const unsubscribe = manager.subscribe((event) => {
      if (event.type !== "agent_stream" || event.event.type !== "timeline") {
        return;
      }
      if (event.event.item.type === "user_message") {
        observedUserMessages.push(event.event.item.text);
      }
    });

    const created = await service.create({
      prompt: "Audit nightly run",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    try {
      await service.tick();
    } finally {
      unsubscribe();
    }

    expect(observedUserMessages).toEqual(["Audit nightly run"]);
    expect((await service.inspect(created.id)).runs[0]?.status).toBe("succeeded");
  });

  test("archives new-agent schedule sessions after the run finishes", async () => {
    class CountingScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id: string;
      closed = false;
      private turnCount = 0;
      private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

      constructor(private readonly config: AgentSessionConfig) {
        this.id = "scheduled-session-1";
      }

      async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "done",
          timeline: [{ type: "assistant_message", text: "done" }],
        };
      }

      async startTurn(
        _prompt: AgentPromptInput,
        _options?: AgentRunOptions,
      ): Promise<{ turnId: string }> {
        const turnId = `turn-${++this.turnCount}`;
        setImmediate(() => {
          this.emit({ type: "turn_started", provider: this.provider, turnId });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "assistant_message", text: "done" },
          });
          this.emit({
            type: "turn_completed",
            provider: this.provider,
            turnId,
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        });
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subscribers.add(callback);
        return () => {
          this.subscribers.delete(callback);
        };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: this.config.model ?? null,
          modeId: this.config.modeId ?? null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return this.config.modeId ?? null;
      }

      async setMode(modeId: string): Promise<void> {
        this.config.modeId = modeId;
      }

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(
        _requestId: string,
        _response: AgentPermissionResponse,
      ): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
          metadata: { ...this.config },
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {
        this.closed = true;
      }

      private emit(event: AgentStreamEvent): void {
        for (const subscriber of this.subscribers) {
          subscriber(event);
        }
      }
    }

    class CountingScheduleClient implements AgentClient {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly sessions: CountingScheduleSession[] = [];

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = new CountingScheduleSession(config);
        this.sessions.push(session);
        return session;
      }

      async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
        const metadata = handle.metadata as Partial<AgentSessionConfig> | undefined;
        const session = new CountingScheduleSession({
          ...metadata,
          provider: this.provider,
          cwd: metadata?.cwd ?? tempDir,
        });
        this.sessions.push(session);
        return session;
      }

      async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
        return { models: [], modes: [] };
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const client = new CountingScheduleClient();
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: { claude: client },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "finish and stop",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toBeTruthy();
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]?.closed).toBe(true);
    expect(manager.getAgent(agentId!)).toBeNull();
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.archivedAt).toBeTruthy();
  });

  test("records prompt-start failures as failed and archives the scheduled agent", async () => {
    class StartFailureScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id = "scheduled-start-failure-session";

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        throw new Error("start turn exploded");
      }

      subscribe(): () => void {
        return () => {};
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return null;
      }

      async setMode(): Promise<void> {}

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: {
        claude: {
          provider: "claude",
          capabilities: SCHEDULE_TEST_CAPABILITIES,
          createSession: async () => new StartFailureScheduleSession(),
          resumeSession: async () => new StartFailureScheduleSession(),
          fetchCatalog: async () => ({ models: [], modes: [] }),
          isAvailable: async () => true,
        },
      },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "this run fails before starting",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: expect.any(String),
      error: expect.stringContaining("start turn exploded"),
    });
    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(1);
    expect(inspected.runs[0]?.agentId).toBe(storedAgents[0]?.id);
    expect(storedAgents[0]).toMatchObject({
      archivedAt: expect.any(String),
    });
  });

  test("defaults new-agent modeId to provider's unattended mode", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: undefined,
          });
          return {
            modeId: input.unattended ? "bypassPermissions" : "interactive",
            featureValues: input.featureValues,
          };
        },
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toBeTruthy();
    const agent = await agentStorage.get(agentId!);
    expect(agent?.lastModeId).toBe("bypassPermissions");
    expect(agent?.archivedAt).toBeTruthy();
  });

  test("defaults OpenCode new-agent schedules to build plus auto accept", async () => {
    const createdConfigs: AgentSessionConfig[] = [];
    const clients = createTestAgentClients();
    const opencodeClient = clients.opencode;
    if (!opencodeClient) {
      throw new Error("Expected OpenCode test client");
    }
    clients.opencode = {
      provider: opencodeClient.provider,
      capabilities: opencodeClient.capabilities,
      createSession: async (...args) => {
        createdConfigs.push(args[0]);
        return opencodeClient.createSession(...args);
      },
      resumeSession: (...args) => opencodeClient.resumeSession(...args),
      fetchCatalog: (...args) => opencodeClient.fetchCatalog(...args),
      isAvailable: () => opencodeClient.isAvailable(),
    } satisfies AgentClient;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients,
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: undefined,
          });
          return {
            modeId: input.unattended ? "build" : "interactive",
            featureValues: input.unattended
              ? { ...input.featureValues, auto_accept: true }
              : input.featureValues,
          };
        },
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "opencode",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]?.error).toBeNull();
    expect(createdConfigs[0]).toMatchObject({
      modeId: "build",
      featureValues: { auto_accept: true },
    });
  });

  test("forwards stored new-agent session config to the launched scheduled agent", async () => {
    const createdConfigs: AgentSessionConfig[] = [];
    const clients = createTestAgentClients();
    const claudeClient = clients.claude;
    if (!claudeClient) {
      throw new Error("Expected Claude test client");
    }
    clients.claude = {
      provider: claudeClient.provider,
      capabilities: claudeClient.capabilities,
      createSession: async (...args) => {
        createdConfigs.push(args[0]);
        return claudeClient.createSession(...args);
      },
      resumeSession: (...args) => claudeClient.resumeSession(...args),
      fetchCatalog: (...args) => claudeClient.fetchCatalog(...args),
      isAvailable: () => claudeClient.isAvailable(),
    } satisfies AgentClient;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients,
      providerDefinitions: { claude: TEST_CLAUDE_PROVIDER_DEFINITION },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: "stored-mode",
          });
          return {
            modeId: input.requestedMode,
            featureValues: { ...input.featureValues, resolved: true },
          };
        },
      },
      now: () => now,
    });

    await service.create({
      prompt: "Use the stored launch config",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          title: "Stored launch title",
          modeId: "stored-mode",
          thinkingOptionId: "think-hard",
          providerOptions: {
            allowedTools: ["Read"],
            sandbox: { enabled: true, network: { allowLocalBinding: true } },
          },
          featureValues: { auto_accept: true },
          systemPrompt: "Stay concise.",
          mcpServers: {
            docs: {
              command: "node",
              args: ["docs-server.js"],
            },
          },
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0]).toMatchObject({
      provider: "claude",
      cwd: tempDir,
      title: "Stored launch title",
      model: "test-model",
      modeId: "stored-mode",
      thinkingOptionId: "think-hard",
      providerOptions: {
        allowedTools: ["Read"],
        sandbox: { enabled: true, network: { allowLocalBinding: true } },
      },
      featureValues: { auto_accept: true, resolved: true },
      systemPrompt: "Stay concise.",
      mcpServers: {
        docs: {
          command: "node",
          args: ["docs-server.js"],
        },
      },
    });
  });

  test("advances stale nextRunAt on daemon restart", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service1.create({
      prompt: "Periodic check",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });

    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
    await service1.stop();

    // Simulate daemon restart 10 minutes later
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();

    const inspected = await service2.inspect(created.id);
    expect(new Date(inspected.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
    await service2.stop();
  });

  test("starts with the valid schedules when the schedules directory holds files that are not schedules", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    const created = await service1.create({
      prompt: "Still scheduled",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });
    await service1.stop();

    const schedulesDir = join(tempDir, "schedules");
    await writeFile(join(schedulesDir, "notes.json"), JSON.stringify({ hello: "world" }));
    const { lastRunAt: _omitted, ...withoutLastRunAt } = created;
    await writeFile(
      join(schedulesDir, "deadbeef.json"),
      JSON.stringify({ ...withoutLastRunAt, id: "deadbeef" }),
    );
    await writeFile(join(schedulesDir, "broken.json"), "{ not json");

    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();

    expect((await service2.list()).map((schedule) => schedule.id)).toEqual([created.id]);
    await service2.stop();
  });

  test("startup recovery archives an interrupted run workspace with an associated agent", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    const created = await service1.create({
      prompt: "Interrupted after creating an agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });
    await service1.stop();

    const interruptedAt = now.toISOString();
    const associatedAgentId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "wks_interrupted_with_agent";
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    await store.update(created.id, (schedule) => ({
      ...schedule,
      runs: [
        ...schedule.runs,
        {
          id: "run-interrupted-with-agent",
          scheduledFor: interruptedAt,
          startedAt: interruptedAt,
          endedAt: null,
          status: "running",
          agentId: associatedAgentId,
          workspaceId,
          output: null,
          error: null,
        },
      ],
    }));

    const archiveCalls: string[] = [];
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
      archiveWorkspace: async (archivedWorkspaceId) => {
        archiveCalls.push(archivedWorkspaceId);
      },
    });
    await service2.start();

    expect(archiveCalls).toEqual([workspaceId]);
    const inspected = await service2.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: associatedAgentId,
      error: "Daemon restarted before the scheduled run completed",
    });
    await service2.stop();
  });

  test("startup recovery archives an interrupted run workspace even before agent association", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    const created = await service1.create({
      prompt: "Interrupted before creating an agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, archiveOnFinish: false },
      },
      runOnCreate: false,
    });
    await service1.stop();

    const interruptedAt = now.toISOString();
    const workspaceId = "wks_interrupted_without_agent";
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    await store.update(created.id, (schedule) => ({
      ...schedule,
      runs: [
        ...schedule.runs,
        {
          id: "run-interrupted-without-agent",
          scheduledFor: interruptedAt,
          startedAt: interruptedAt,
          endedAt: null,
          status: "running",
          agentId: null,
          workspaceId,
          output: null,
          error: null,
        },
      ],
    }));

    const archiveCalls: string[] = [];
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
      archiveWorkspace: async (archivedWorkspaceId) => {
        archiveCalls.push(archivedWorkspaceId);
      },
    });
    await service2.start();

    expect(archiveCalls).toEqual([workspaceId]);
    const inspected = await service2.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: null,
      error: "Daemon restarted before the scheduled run completed",
    });
    await service2.stop();
  });

  test("keeps schedules paused when an in-flight run finishes after pause", async () => {
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
      finishRun = resolve;
    });

    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        releaseRun?.();
        await runBlocked;
        return {
          agentId: null,
          output: "finished",
        };
      },
    });

    const created = await service.create({
      prompt: "Check status",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    const tickPromise = service.tick();
    await runStarted;

    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();

    finishRun?.();
    await tickPromise;

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("paused");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
  });

  test("rejects archived target agents before loading them", async () => {
    const manager = new AgentManager({ logger: createTestLogger() });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    await agentStorage.upsert({
      id: "archived-agent",
      provider: "claude",
      cwd: tempDir,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      lastUserMessageAt: null,
      title: "Archived Agent",
      labels: {},
      lastStatus: "closed",
      lastModeId: "default",
      config: {
        modeId: "default",
      },
      runtimeInfo: null,
      features: [],
      persistence: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      internal: false,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });

    await expect(
      (service as unknown as ScheduleServiceInternals).executeSchedule(
        {
          id: "schedule-1",
          name: null,
          prompt: "Check archived agent",
          cadence: { type: "every", everyMs: 60_000 },
          target: {
            type: "agent",
            agentId: "archived-agent",
          },
          status: "active",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          nextRunAt: now.toISOString(),
          lastRunAt: null,
          pausedAt: null,
          expiresAt: null,
          maxRuns: null,
          runs: [],
        },
        "run-1",
      ),
    ).rejects.toThrow("Agent archived-agent is archived");
  });

  test("defaults --every schedules to fire immediately on creation", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "every default",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    expect(created.nextRunAt).toBe(now.toISOString());
  });

  test("--every with runOnCreate=false waits the full interval", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "wait interval",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });

    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
  });

  test("--cron defaults to the next cron slot", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "cron default",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
  });

  test("--cron with runOnCreate=true fires immediately on creation", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "cron run-now",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: true,
    });

    expect(created.nextRunAt).toBe(now.toISOString());
  });

  test("runOnce records a run without changing nextRunAt or completing the schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async (schedule) => ({
        agentId: "00000000-0000-0000-0000-000000000099",
        output: `manual:${schedule.prompt}`,
      }),
    });

    const created = await service.create({
      prompt: "manual fire",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      maxRuns: 1,
    });
    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");

    const after = await service.runOnce(created.id);
    expect(after.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(after.status).toBe("active");
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000099",
      output: "manual:manual fire",
    });
  });

  test("update mutates cadence, prompt, name, and target fields in place", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      name: "morning",
      prompt: "first prompt",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, modeId: "default" },
      },
    });
    expect(created.runs).toEqual([]);

    now = new Date("2026-01-01T00:00:30.000Z");
    const nextCwd = join(tempDir, "new-path");
    await mkdir(nextCwd, { recursive: true });
    const updated = await service.update({
      id: created.id,
      prompt: "second prompt",
      name: "renamed",
      cadence: { type: "every", everyMs: 5 * 60_000 },
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        thinkingOptionId: "deep-thought",
        archiveOnFinish: false,
        isolation: "worktree",
        cwd: nextCwd,
      },
    });

    expect(updated.prompt).toBe("second prompt");
    expect(updated.name).toBe("renamed");
    expect(updated.cadence).toEqual({ type: "every", everyMs: 5 * 60_000 });
    expect(updated.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: nextCwd,
        model: "gpt-5",
        modeId: "full-access",
        thinkingOptionId: "deep-thought",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    });
    expect(updated.nextRunAt).toBe("2026-01-01T00:05:30.000Z");
    expect(updated.updatedAt).toBe("2026-01-01T00:00:30.000Z");
    expect(updated.createdAt).toBe(created.createdAt);
  });

  test("update switches between every and cron cadences and recomputes nextRunAt", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(created.nextRunAt).toBe("2026-01-01T00:00:00.000Z");

    const cron = await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
    expect(cron.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(cron.nextRunAt).toBe("2026-01-01T09:30:00.000Z");

    const back = await service.update({
      id: created.id,
      cadence: { type: "every", everyMs: 2 * 60_000 },
    });
    expect(back.cadence).toEqual({ type: "every", everyMs: 2 * 60_000 });
    expect(back.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("update preserves a cron cadence timezone when the new cadence omits it", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: {
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    const updated = await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "30 9 * * *" },
    });

    expect(updated.cadence).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
  });

  test("update preserves nextRunAt and run history when cadence is unchanged", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ran" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const after = await service.inspect(created.id);
    expect(after.runs).toHaveLength(1);

    now = new Date("2026-01-01T00:01:30.000Z");
    const updated = await service.update({ id: created.id, prompt: "new prompt" });

    expect(updated.prompt).toBe("new prompt");
    expect(updated.cadence).toEqual(created.cadence);
    expect(updated.nextRunAt).toBe(after.nextRunAt);
    expect(updated.runs).toEqual(after.runs);
    expect(updated.lastRunAt).toBe(after.lastRunAt);
  });

  test("update clears the schedule name when given an empty string", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      name: "named",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(created.name).toBe("named");

    const cleared = await service.update({ id: created.id, name: "" });
    expect(cleared.name).toBeNull();

    const renamed = await service.update({ id: created.id, name: "again" });
    expect(renamed.name).toBe("again");
  });

  test("update rejects new-agent fields on agent-target schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "agent target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000005" },
    });

    await expect(
      service.update({
        id: created.id,
        newAgentConfig: { provider: "codex" },
      }),
    ).rejects.toThrow("only valid for new-agent target schedules");
  });

  test("update changes individual new-agent fields independently", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, model: "sonnet", modeId: "default" },
      },
    });

    const modeOnly = await service.update({
      id: created.id,
      newAgentConfig: { modeId: "bypassPermissions" },
    });
    expect(modeOnly.target).toMatchObject({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: tempDir,
        model: "sonnet",
        modeId: "bypassPermissions",
      },
    });

    const clearModel = await service.update({
      id: created.id,
      newAgentConfig: { model: null },
    });
    if (clearModel.target.type !== "new-agent") {
      throw new Error("target type changed unexpectedly");
    }
    expect(clearModel.target.config.model).toBeUndefined();
    expect(clearModel.target.config.modeId).toBe("bypassPermissions");
  });

  test("update returns a schedule that round-trips through the store", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "0 9 * * *" },
      newAgentConfig: { provider: "codex", modeId: "full-access" },
    });

    const reloaded = await service.inspect(created.id);
    expect(reloaded.cadence).toEqual({ type: "cron", expression: "0 9 * * *" });
    expect(reloaded.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: tempDir,
        modeId: "full-access",
      },
    });
  });

  test("runOnce rejects completed schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "one-shot",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      maxRuns: 1,
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    await expect(service.runOnce(created.id)).rejects.toThrow("already completed");
  });

  test("completeForAgent completes only schedules targeting that agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const targetAgentId = "11111111-1111-4111-8111-111111111111";
    const otherAgentId = "22222222-2222-4222-8222-222222222222";

    const targeted = await service.create({
      prompt: "ping the doomed agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: targetAgentId },
    });
    const otherTargeted = await service.create({
      prompt: "ping the other agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: otherAgentId },
    });
    const newAgentSchedule = await service.create({
      prompt: "spawn a fresh agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    now = new Date("2026-01-01T00:05:00.000Z");
    const completed = await service.completeForAgent(targetAgentId);
    expect(completed).toBe(1);

    const remaining = await service.list();
    expect(remaining.map((schedule) => schedule.id).sort()).toEqual(
      [targeted.id, otherTargeted.id, newAgentSchedule.id].sort(),
    );

    const doomed = await service.inspect(targeted.id);
    expect(doomed.status).toBe("completed");
    expect(doomed.nextRunAt).toBeNull();
    expect(doomed.updatedAt).toBe("2026-01-01T00:05:00.000Z");

    expect((await service.inspect(otherTargeted.id)).status).toBe("active");
    expect((await service.inspect(newAgentSchedule.id)).status).toBe("active");
  });

  test("startup sweep completes agent-target schedules whose agent is gone", async () => {
    const missingAgentId = "44444444-4444-4444-8444-444444444444";
    const archivedAgentId = "55555555-5555-4555-8555-555555555555";
    const liveAgentId = "66666666-6666-4666-8666-666666666666";

    await agentStorage.upsert(
      buildAgentRecord({
        id: archivedAgentId,
        cwd: tempDir,
        iso: now.toISOString(),
        archivedAt: "2026-01-01T00:00:30.000Z",
      }),
    );
    await agentStorage.upsert(
      buildAgentRecord({ id: liveAgentId, cwd: tempDir, iso: now.toISOString() }),
    );

    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const missing = await service1.create({
      prompt: "ping missing",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: missingAgentId },
    });
    const archived = await service1.create({
      prompt: "ping archived",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: archivedAgentId },
    });
    const live = await service1.create({
      prompt: "ping live",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: liveAgentId },
    });
    const newAgent = await service1.create({
      prompt: "spawn fresh",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const pausedMissing = await service1.create({
      prompt: "paused ping missing",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1" },
    });
    await service1.pause(pausedMissing.id);
    const pausedLive = await service1.create({
      prompt: "paused ping live",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: liveAgentId },
    });
    await service1.pause(pausedLive.id);

    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();
    await service2.stop();

    expect((await service2.inspect(missing.id)).status).toBe("completed");
    expect((await service2.inspect(missing.id)).nextRunAt).toBeNull();
    expect((await service2.inspect(archived.id)).status).toBe("completed");
    expect((await service2.inspect(live.id)).status).toBe("active");
    expect((await service2.inspect(newAgent.id)).status).toBe("active");
    // Paused schedules are swept too when their agent is gone, but survive when it lives.
    expect((await service2.inspect(pausedMissing.id)).status).toBe("completed");
    expect((await service2.inspect(pausedLive.id)).status).toBe("paused");
  });

  test("completes the schedule when a scheduled run reports the target is gone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        throw new ScheduleTargetGoneError("Agent 77777777-7777-4777-8777-777777777777 is archived");
      },
    });

    const created = await service.create({
      prompt: "ping gone target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "77777777-7777-4777-8777-777777777777" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toBe("Agent 77777777-7777-4777-8777-777777777777 is archived");
  });

  test("does not resurrect nextRunAt when the schedule completes during an in-flight run", async () => {
    const agentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let service!: ScheduleService;
    service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        // Simulate the agent being archived mid-run: the archive callback
        // completes the schedule before this run finishes.
        await service.completeForAgent(agentId);
        return { agentId: null, output: "ok" };
      },
    });

    const created = await service.create({
      prompt: "ping",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("succeeded");
  });

  test("keeps the schedule active when a run fails for a transient reason", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        throw new Error("network blip");
      },
    });

    const created = await service.create({
      prompt: "ping flaky target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "88888888-8888-4888-8888-888888888888" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("active");
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toBe("network blip");
  });

  // chmod cannot make a directory unwritable on Windows or for root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fires again after a tick whose run could not be recorded",
    async () => {
      const service = createScheduleService({
        paseoHome: tempDir,
        logger: createTestLogger(),
        agentManager: new AgentManager({ logger: createTestLogger() }),
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
        runner: async () => ({ agentId: null, output: "ran" }),
      });

      const created = await service.create({
        prompt: "ping target",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "agent", agentId: "88888888-8888-4888-8888-888888888888" },
      });

      const schedulesDir = join(tempDir, "schedules");
      now = new Date("2026-01-01T00:01:00.000Z");
      await chmod(schedulesDir, 0o555);
      try {
        await expect(service.tick()).rejects.toThrow();
      } finally {
        await chmod(schedulesDir, 0o755);
      }

      await service.tick();

      const inspected = await service.inspect(created.id);
      expect(inspected.runs).toHaveLength(1);
      expect(inspected.runs[0]?.status).toBe("succeeded");
      expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    },
  );

  test("completes the schedule when a scheduled run targets an archived agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const archivedAgentId = "99999999-9999-4999-8999-999999999999";
    await agentStorage.upsert(
      buildAgentRecord({
        id: archivedAgentId,
        cwd: tempDir,
        iso: now.toISOString(),
        archivedAt: "2026-01-01T00:00:30.000Z",
      }),
    );

    const created = await service.create({
      prompt: "ping archived target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: archivedAgentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("is archived");
  });

  test("completes the schedule when a scheduled run targets a missing agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "ping missing target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
  });

  test("completes the schedule when a new-agent run's cwd no longer exists", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const deletedWorktree = join(tempDir, "deleted-worktree");
    await mkdir(deletedWorktree, { recursive: true });
    const created = await service.create({
      prompt: "spawn in a deleted dir",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: deletedWorktree,
          providerOptions: { allowedTools: ["Read"] },
        },
      },
    });
    await rm(deletedWorktree, { recursive: true, force: true });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("no longer exists");
  });

  test("keeps the schedule active when a real run fails for a non-gone reason", async () => {
    // No providers registered: the agent exists and is live, but loading it fails
    // with a plain error (not ScheduleTargetGoneError), so the schedule must retry.
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const agentId = "12121212-1212-4121-8121-121212121212";
    await agentStorage.upsert(
      buildAgentRecord({ id: agentId, cwd: tempDir, iso: now.toISOString() }),
    );

    const created = await service.create({
      prompt: "ping live but unavailable",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("active");
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("unavailable provider");
  });

  test("runOnce completes the schedule when the target is gone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "manual ping gone target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "13131313-1313-4131-8131-131313131313" },
    });

    const after = await service.runOnce(created.id);
    expect(after.status).toBe("completed");
    expect(after.nextRunAt).toBeNull();
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]?.status).toBe("failed");
  });

  test("createOrReplace updates the matching schedule in place instead of duplicating", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await service.createOrReplace({
      name: "babysit-pr PR 1112",
      prompt: "watch the build",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    expect((await service.inspect(first.id)).runs).toHaveLength(1);
    await service.pause(first.id);

    now = new Date("2026-01-01T00:02:00.000Z");
    const second = await service.createOrReplace({
      name: "babysit-pr PR 1112",
      prompt: "watch the build v2",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: { type: "agent", agentId },
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.prompt).toBe("watch the build v2");
    expect(second.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(second.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.runs).toHaveLength(1);
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace preserves an existing cron timezone when replacement omits timezone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await service.createOrReplace({
      name: "timezone-aware cron",
      prompt: "watch the build",
      cadence: { type: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
      target: { type: "agent", agentId },
    });

    const second = await service.createOrReplace({
      name: "timezone-aware cron",
      prompt: "watch the build v2",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: { type: "agent", agentId },
    });

    expect(second.id).toBe(first.id);
    expect(second.cadence).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace creates a sibling when name, target, or completion differ", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const agentB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    await service.createOrReplace({
      name: "dup",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    await service.createOrReplace({
      name: "other",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    await service.createOrReplace({
      name: "dup",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentB },
    });

    const done = await service.createOrReplace({
      name: "done",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
      maxRuns: 1,
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    expect((await service.inspect(done.id)).status).toBe("completed");

    const redone = await service.createOrReplace({
      name: "done",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    expect(redone.id).not.toBe(done.id);

    expect(await service.list()).toHaveLength(5);
  });

  test("createOrReplace never dedups anonymous schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await service.createOrReplace({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });
    await service.createOrReplace({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    expect(await service.list()).toHaveLength(2);
  });

  test("createOrReplace matches new-agent targets by config", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const first = await service.createOrReplace({
      name: "nightly",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const second = await service.createOrReplace({
      name: "nightly",
      prompt: "audit v2",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);

    const subCwd = join(tempDir, "sub");
    await mkdir(subCwd, { recursive: true });
    const third = await service.createOrReplace({
      name: "nightly",
      prompt: "audit elsewhere",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: subCwd } },
    });
    expect(third.id).not.toBe(first.id);
    expect(await service.list()).toHaveLength(2);
  });

  test("concurrent createOrReplace first creates share one schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const firstPromise = service.createOrReplace({
      name: "nightly race",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const secondPromise = service.createOrReplace({
      name: "nightly race",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace dedups new-agent targets regardless of config key order", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    // The stored config is round-tripped through the Zod schema (schema key
    // order); this incoming literal deliberately uses a different key order.
    const first = await service.createOrReplace({
      name: "nightly",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
          providerOptions: { allowedTools: ["Read"] },
          title: "nightly job",
        },
      },
    });
    const second = await service.createOrReplace({
      name: "nightly",
      prompt: "audit v2",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
          providerOptions: { allowedTools: ["Read"] },
          title: "nightly job",
        },
      },
    });

    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
  });

  test("completeForAgent skips schedules that are already completed", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "33333333-3333-4333-8333-333333333333";
    await service.create({
      prompt: "already done",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    expect(await service.completeForAgent(agentId)).toBe(1);
    expect(await service.completeForAgent(agentId)).toBe(0);
  });
});
