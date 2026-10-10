import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "./agent-storage.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import { syncFilePublication } from "../atomic-file.js";
import { PromptAnnotationStore } from "./prompt-annotations.js";
import { buildConfigOverrides, buildSessionConfig } from "../persistence-hooks.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
};

function buildManagedAgentConfig(
  provider: AgentProvider,
  cwd: string,
  configOverrides: Partial<AgentSessionConfig>,
): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider,
    cwd,
    title: configOverrides.title,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "gpt-5.1",
    thinkingOptionId: configOverrides.thinkingOptionId,
    providerOptions: configOverrides.providerOptions,
    toolPolicy: configOverrides.toolPolicy,
    systemPrompt: configOverrides.systemPrompt,
    mcpServers: configOverrides.mcpServers,
  };
  if (Object.prototype.hasOwnProperty.call(configOverrides, "featureValues")) {
    config.featureValues = configOverrides.featureValues;
  }
  return config;
}

function buildDefaultCapabilities() {
  return {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
}

function buildDefaultRuntimeInfo(params: {
  provider: AgentProvider;
  config: AgentSessionConfig;
  sessionId: string;
}) {
  return {
    provider: params.provider,
    sessionId: params.sessionId,
    model: params.config.model ?? null,
    modeId: params.config.modeId ?? null,
  };
}

interface ManagedAgentCore {
  provider: AgentProvider;
  cwd: string;
  lifecycle: ManagedAgent["lifecycle"];
  config: AgentSessionConfig;
  session: AgentSession | null;
  activeForegroundTurnId: string | null;
  now: Date;
}

function resolveManagedAgentCore(overrides: ManagedAgentOverrides): ManagedAgentCore {
  const now = overrides.updatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const provider = overrides.provider ?? "claude";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const config = buildManagedAgentConfig(provider, cwd, overrides.config ?? {});
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  return { provider, cwd, lifecycle, config, session, activeForegroundTurnId, now };
}

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const core = resolveManagedAgentCore(overrides);
  return {
    id: overrides.id ?? "agent-test",
    runtimeGenerationId: overrides.runtimeGenerationId,
    provider: core.provider,
    cwd: core.cwd,
    workspaceId: overrides.workspaceId,
    session: core.session,
    capabilities: overrides.capabilities ?? buildDefaultCapabilities(),
    config: core.config,
    lifecycle: core.lifecycle,
    createdAt: overrides.createdAt ?? core.now,
    updatedAt: overrides.updatedAt ?? core.now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? core.config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: core.activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo:
      overrides.runtimeInfo ??
      buildDefaultRuntimeInfo({
        provider: core.provider,
        config: core.config,
        sessionId: overrides.sessionId ?? "session-123",
      }),
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? core.now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };
}

describe("AgentStorage", () => {
  let tmpDir: string;
  let storagePath: string;
  let storage: AgentStorage;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
    storagePath = path.join(tmpDir, "agents");
    storage = new AgentStorage(storagePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.skipIf(process.platform === "win32")(
    "snapshots and replacement runtimes preserve an outstanding annotation publication",
    async () => {
      const agent = createManagedAgent({ id: "annotations-agent" });
      const seed = toStoredAgentRecord(agent);
      agent.runtimeGenerationId = await storage.beginRuntimeGeneration(seed);
      expect((await storage.get(agent.id))?.promptAnnotations).toMatchObject({
        revision: 0,
        entryCount: 0,
        coverage: "from_creation",
      });
      const annotations = new PromptAnnotationStore(path.join(tmpDir, "annotations"), {
        records: storage,
        synchronize: async () => {
          throw new Error("annotation sync failed");
        },
      });
      await expect(
        annotations.remember(agent.id, {
          messageId: "wake",
          text: "wake",
          annotation: { kind: "notification", level: "info", message: "wake" },
        }),
      ).rejects.toThrow("annotation sync failed");
      const prepared = await storage.get(agent.id);
      expect(prepared?.pendingPromptAnnotationPublication).toBeDefined();
      await storage.applySnapshot(agent);
      await storage.upsert({ ...seed, runtimeGeneration: prepared?.runtimeGeneration });
      await storage.applySnapshot(
        createManagedAgent({
          id: agent.id,
          lifecycle: "closed",
          runtimeGenerationId: agent.runtimeGenerationId,
        }),
      );
      await expect(storage.checkpointClosedAgent(agent.id)).rejects.toThrow(
        "pending prompt annotation",
      );
      await storage.beginRuntimeGeneration(seed);
      const reopened = await new AgentStorage(storagePath, logger).get(agent.id);
      expect(reopened?.promptAnnotations).toEqual(prepared?.promptAnnotations);
      expect(reopened?.pendingPromptAnnotationPublication).toEqual(
        prepared?.pendingPromptAnnotationPublication,
      );
    },
  );

  test("runtime generations reject late snapshots after close and after a replacement opens", async () => {
    const agent = createManagedAgent({ id: "generation-agent" });
    const seed = toStoredAgentRecord(agent);
    agent.runtimeGenerationId = await storage.beginRuntimeGeneration(seed);
    await storage.applySnapshot(agent);
    const closed = createManagedAgent({
      id: agent.id,
      runtimeGenerationId: agent.runtimeGenerationId,
      lifecycle: "closed",
    });
    await storage.applySnapshot(closed);
    await expect(storage.applySnapshot(agent)).rejects.toThrow("already closed");

    const oldRecord = await storage.get(agent.id);
    const replacementId = await storage.beginRuntimeGeneration(seed);
    expect(replacementId).not.toBe(agent.runtimeGenerationId);
    await expect(storage.applySnapshot(closed)).rejects.toThrow("different runtime generation");
    await expect(storage.upsert({ ...oldRecord!, title: "Late metadata" })).rejects.toThrow(
      "different runtime generation",
    );
    const reloaded = new AgentStorage(storagePath, logger);
    expect(await reloaded.get(agent.id)).toMatchObject({
      lastStatus: "initializing",
      runtimeGeneration: { id: replacementId },
    });
  });

  test.skipIf(process.platform === "win32")(
    "a new runtime and clean close cannot clear an unresolved predecessor",
    async () => {
      const agent = createManagedAgent({ id: "unresolved-generation" });
      const seed = toStoredAgentRecord(agent);
      const originalId = await storage.beginRuntimeGeneration(seed);
      storage = new AgentStorage(storagePath, logger);
      const replacementId = await storage.beginRuntimeGeneration(seed);
      await storage.applySnapshot(
        createManagedAgent({
          id: agent.id,
          runtimeGenerationId: replacementId,
          lifecycle: "closed",
        }),
      );
      const record = await storage.get(agent.id);
      await storage.upsert({ ...record!, unresolvedRuntimeGenerations: undefined });
      const reloaded = new AgentStorage(storagePath, logger);
      expect((await reloaded.get(agent.id))?.unresolvedRuntimeGenerations).toEqual([
        { id: originalId, openedAt: expect.any(String) },
      ]);
      await expect(reloaded.checkpointClosedAgent(agent.id)).rejects.toThrow(
        "unresolved runtime generations",
      );
    },
  );

  test("runtime recovery refuses another opening at capacity instead of discarding evidence", async () => {
    const seed = toStoredAgentRecord(createManagedAgent({ id: "bounded-generations" }));
    const generations: string[] = [];
    for (let index = 0; index < 33; index++)
      generations.push(await storage.beginRuntimeGeneration(seed));
    await expect(storage.beginRuntimeGeneration(seed)).rejects.toThrow(
      "runtime recovery is required",
    );
    const reloaded = new AgentStorage(storagePath, logger);
    const record = await reloaded.get(seed.id);
    expect(record?.unresolvedRuntimeGenerations?.map((generation) => generation.id)).toEqual(
      generations.slice(0, 32),
    );
    expect(record?.runtimeGeneration?.id).toBe(generations[32]);
  });

  test("applySnapshot persists configs and snapshot metadata", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        lifecycle: "idle",
        config: {
          title: "Initial title",
          modeId: "coding",
          model: "gpt-5.1",
          systemPrompt: "Be terse and explicit.",
          providerOptions: { allowedTools: ["Read"] },
          mcpServers: {
            paseo: {
              type: "stdio",
              command: "node",
              args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
            },
          },
        },
      }),
    );

    const records = await storage.list();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.provider).toBe("claude");
    expect(record.config?.modeId).toBe("coding");
    expect(record.config?.model).toBe("gpt-5.1");
    expect(record.config?.systemPrompt).toBe("Be terse and explicit.");
    expect(record.config?.mcpServers).toEqual({
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
      },
    });
    expect(record.lastModeId).toBe("coding");
    expect(record.lastStatus).toBe("idle");

    const reloaded = new AgentStorage(storagePath, logger);
    const [persisted] = await reloaded.list();
    expect(persisted.cwd).toBe("/tmp/project");
    expect(persisted.config?.providerOptions).toEqual({ allowedTools: ["Read"] });
  });

  test("applySnapshot stores and reloads featureValues when present", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-feature-values",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-feature-values");
    expect(record?.config?.featureValues).toEqual({ fast_mode: true });

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-feature-values");
    expect(persisted?.config?.featureValues).toEqual({ fast_mode: true });
    expect(buildSessionConfig(persisted!).featureValues).toEqual({ fast_mode: true });
  });

  test("applySnapshot keeps featureValues absent when they were never set", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-no-feature-values",
      }),
    );

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-no-feature-values");
    expect(persisted?.config?.featureValues).toBeUndefined();
    expect(buildSessionConfig(persisted!).featureValues).toBeUndefined();
  });

  test("buildConfigOverrides includes featureValues when present in stored config", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-resume-overrides",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-resume-overrides");
    expect(record).not.toBeNull();
    expect(buildConfigOverrides(record!)).toMatchObject({
      cwd: "/tmp/project",
      featureValues: {
        fast_mode: true,
      },
    });
  });

  test("applySnapshot preserves original createdAt timestamp", async () => {
    const agentId = "agent-created-at";
    const firstTimestamp = new Date("2025-01-01T00:00:00.000Z");
    await storage.applySnapshot(createManagedAgent({ id: agentId, createdAt: firstTimestamp }));

    const initialRecord = await storage.get(agentId);
    expect(initialRecord?.createdAt).toBe(firstTimestamp.toISOString());

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        createdAt: new Date("2025-02-01T00:00:00.000Z"),
        updatedAt: new Date("2025-02-01T00:00:00.000Z"),
        lifecycle: "running",
      }),
    );

    const updatedRecord = await storage.get(agentId);
    expect(updatedRecord?.createdAt).toBe(firstTimestamp.toISOString());
    expect(updatedRecord?.lastStatus).toBe("running");
  });

  test("a queued snapshot retains the admitted state while the live agent changes", async () => {
    await storage.initialize();
    const agent = createManagedAgent({ id: "changing-agent", config: { model: "admitted-model" } });
    const admittedTime = agent.updatedAt.toISOString();
    const publication = storage.applySnapshot(agent);
    agent.config.model = "later-model";
    agent.updatedAt.setUTCFullYear(2030);
    await publication;

    const reloaded = new AgentStorage(storagePath, logger);
    expect(await reloaded.get(agent.id)).toMatchObject({
      config: { model: "admitted-model" },
      updatedAt: admittedTime,
    });
  });

  test("applySnapshot preserves archivedAt (soft-delete) status", async () => {
    const agentId = "agent-archived";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
      }),
    );

    const archivedAt = "2025-01-03T00:00:00.000Z";
    const recordBeforeArchive = await storage.get(agentId);
    expect(recordBeforeArchive).not.toBeNull();
    await storage.upsert({ ...recordBeforeArchive!, archivedAt });

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );

    const recordAfterSnapshot = await storage.get(agentId);
    expect(recordAfterSnapshot?.archivedAt).toBe(archivedAt);
  });

  test("stores titles independently of snapshots", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-2",
        provider: "codex",
        cwd: "/tmp/second",
      }),
    );
    await storage.setTitle("agent-2", "Fix Login Bug");

    const current = await storage.get("agent-2");
    expect(current?.title).toBe("Fix Login Bug");

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-2");
    expect(persisted?.title).toBe("Fix Login Bug");
  });

  test("setTitle throws when the agent record does not exist", async () => {
    await expect(storage.setTitle("missing-agent", "Impossible")).rejects.toThrow(
      "Agent missing-agent not found",
    );
  });

  test("applySnapshot accepts explicit title overrides", async () => {
    const agentId = "agent-override";
    await storage.applySnapshot(createManagedAgent({ id: agentId }), { title: "Provided Title" });

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Provided Title");
  });

  test("applySnapshot preserves custom titles while updating metadata", async () => {
    const agentId = "agent-3";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
        currentModeId: "plan",
      }),
    );
    await storage.setTitle(agentId, "Important Bug Fix");

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        currentModeId: "build",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Important Bug Fix");
    expect(record?.lastModeId).toBe("build");
    expect(record?.lastStatus).toBe("running");
  });

  test("applySnapshot projects metadata after in-flight archival writes", async () => {
    const agentId = "agent-pending-write";
    await storage.applySnapshot(createManagedAgent({ id: agentId }));
    const initialRecord = await storage.get(agentId);
    expect(initialRecord).not.toBeNull();

    let releasePendingWrite: (() => void) | null = null;
    const pendingWrite = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });

    const storageInternals = storage as unknown as {
      pendingWrites: Map<string, Promise<void>>;
      cache: Map<string, unknown>;
    };
    storageInternals.pendingWrites.set(agentId, pendingWrite);

    const applySnapshotPromise = storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    storageInternals.cache.set(agentId, {
      ...initialRecord!,
      title: "Generated title",
      archivedAt: "2025-01-03T00:00:00.000Z",
    });
    releasePendingWrite?.();

    await applySnapshotPromise;
    const record = await storage.get(agentId);
    expect(record?.title).toBe("Generated title");
    expect(record?.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  });

  test("list returns all agents including internal ones", async () => {
    // Create a normal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "normal-agent",
        cwd: "/tmp/project",
      }),
    );

    // Create an internal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Registry should return all agents - filtering is done at the manager level
    const records = await storage.list();
    expect(records).toHaveLength(2);
  });

  test("get returns internal agents by ID", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    const record = await storage.get("internal-agent");
    expect(record).not.toBeNull();
    expect(record?.internal).toBe(true);
  });

  test("queries agents by provider session and native handle", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "matching-session",
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "session-1",
          nativeHandle: "thread-1",
        },
      }),
    );
    await storage.applySnapshot(
      createManagedAgent({
        id: "other-session",
        provider: "codex",
        persistence: { provider: "codex", sessionId: "session-2" },
      }),
    );

    await expect(storage.listByProviderSession("codex", "session-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
    await expect(storage.listByProviderSession("codex", "thread-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
  });

  test("queries agents by workspace", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "workspace-agent", workspaceId: "workspace-1" }),
    );
    await storage.applySnapshot(
      createManagedAgent({ id: "other-workspace-agent", workspaceId: "workspace-2" }),
    );

    await expect(storage.listByWorkspace("workspace-1")).resolves.toMatchObject([
      { id: "workspace-agent" },
    ]);
  });

  test("handoff inventory refuses damaged records instead of silently omitting them", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "handoff-agent", workspaceId: "workspace-1", lifecycle: "closed" }),
    );
    await expect(storage.listByWorkspaceForHandoff("workspace-1")).resolves.toMatchObject([
      { id: "handoff-agent" },
    ]);
    const damaged = path.join(storagePath, "damaged.json");
    await fs.writeFile(damaged, "{");
    await expect(storage.listByWorkspaceForHandoff("workspace-1")).rejects.toThrow();
    const reloaded = new AgentStorage(storagePath, logger);
    await expect(reloaded.listByWorkspace("workspace-1")).resolves.toMatchObject([
      { id: "handoff-agent" },
    ]);
    await expect(reloaded.listByWorkspaceForHandoff("workspace-1")).rejects.toThrow();
    await fs.rm(damaged);
    await expect(reloaded.listByWorkspaceForHandoff("workspace-1")).resolves.toMatchObject([
      { id: "handoff-agent" },
    ]);
  });

  test("handoff inventory refuses a record lost after it was loaded", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "handoff-agent", workspaceId: "workspace-1", lifecycle: "closed" }),
    );
    await fs.rm(storagePath, { recursive: true });
    await expect(storage.listByWorkspaceForHandoff("workspace-1")).rejects.toThrow(
      "inventory differs from persisted storage",
    );
  });

  test("a rejected mutation does not discard the next queued restart note", async () => {
    const agentId = "queued-agent";
    await storage.applySnapshot(createManagedAgent({ id: agentId }));
    const note = { kind: "turn", label: "Interrupted work", id: "interrupted-turn" };

    const outcomes = await Promise.allSettled([
      storage.completeHandoffContext(agentId),
      storage.addPendingRestartNote(agentId, [note]),
    ]);

    expect(outcomes).toEqual([
      { status: "rejected", reason: new Error(`Agent ${agentId} has no handoff context`) },
      { status: "fulfilled", value: undefined },
    ]);
    const reloaded = new AgentStorage(storagePath, logger);
    expect((await reloaded.get(agentId))?.pendingRestartNote).toEqual([note]);
  });

  test.skipIf(process.platform === "win32")(
    "a restart note is acknowledged only after synchronization and repairs its retained input",
    async () => {
      let failSync = true;
      storage = new AgentStorage(storagePath, logger, undefined, async (file, root) => {
        if (failSync) throw new Error("restart note sync failed");
        await syncFilePublication(file, root);
      });
      const agentId = "restart-note-agent";
      await storage.applySnapshot(createManagedAgent({ id: agentId }));
      const note = { kind: "shell", label: "npm run dev", id: "lost-task" };

      await expect(storage.addPendingRestartNote(agentId, [note])).rejects.toThrow(
        "restart note sync failed",
      );
      expect((await storage.get(agentId))?.pendingRestartNote).toBeUndefined();
      note.label = "mutated after the failed write";
      failSync = false;
      await storage.repairPendingPersistence(agentId);

      const reloaded = new AgentStorage(storagePath, logger);
      expect((await reloaded.get(agentId))?.pendingRestartNote).toEqual([
        { kind: "shell", label: "npm run dev", id: "lost-task" },
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a renamed handoff record is not acknowledged before synchronization succeeds",
    async () => {
      const record = toStoredAgentRecord(
        createManagedAgent({
          id: "incoming-agent",
          workspaceId: "incoming-workspace",
          lifecycle: "closed",
        }),
      );
      let failSync = true;
      const publishedTitles: Array<string | null | undefined> = [];
      storage = new AgentStorage(
        storagePath,
        logger,
        undefined,
        async (filePath, publicationRoot) => {
          publishedTitles.push(JSON.parse(await fs.readFile(filePath, "utf8")).title);
          if (failSync) throw new Error("injected directory sync failure");
          await syncFilePublication(filePath, publicationRoot);
        },
      );

      await expect(storage.installHandoffRecord(record)).rejects.toThrow(
        "injected directory sync failure",
      );
      expect(await storage.get(record.id)).toBeNull();
      await expect(storage.listByWorkspaceForHandoff("incoming-workspace")).rejects.toThrow();
      await expect(storage.setTitle(record.id, "Changed after repair")).rejects.toThrow(
        "injected directory sync failure",
      );
      expect(await storage.get(record.id)).toBeNull();

      // Retry uses the retained input, even if the rejected caller changes its object.
      record.title = "Changed by rejected caller";
      failSync = false;
      await storage.setTitle(record.id, "Changed after repair");
      expect(publishedTitles).toEqual([null, null, null, null]);
      const reloaded = new AgentStorage(storagePath, logger);
      expect(await reloaded.get(record.id)).toMatchObject({
        title: "Changed after repair",
        lastStatus: "closed",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff retries the retained closed snapshot after its first write fails",
    async () => {
      const agentId = "failed-close";
      await storage.applySnapshot(
        createManagedAgent({ id: agentId, workspaceId: "retry-workspace" }),
      );
      const backup = `${storagePath}-backup`;
      await fs.rename(storagePath, backup);
      await fs.writeFile(storagePath, "blocked storage directory");
      const closed = createManagedAgent({
        id: agentId,
        lifecycle: "closed",
        workspaceId: "retry-workspace",
        config: { model: "final-model" },
      });
      await expect(storage.applySnapshot(closed)).rejects.toThrow();
      expect((await storage.get(agentId))?.lastStatus).toBe("idle");
      closed.config.model = "stale-runtime-mutation";

      await fs.rm(storagePath);
      await fs.rename(backup, storagePath);
      await expect(storage.listByWorkspaceForHandoff("retry-workspace")).resolves.toMatchObject([
        { id: agentId, lastStatus: "closed" },
      ]);
      const checkpoint = await storage.checkpointClosedAgent(agentId);
      expect(checkpoint).toMatchObject({ lastStatus: "closed", config: { model: "final-model" } });
      const reloaded = new AgentStorage(storagePath, logger);
      expect(await reloaded.get(agentId)).toMatchObject({
        lastStatus: "closed",
        config: { model: "final-model" },
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "deletion removes a renamed record even when its in-flight synchronization fails",
    async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      storage = new AgentStorage(storagePath, logger, undefined, async () => {
        entered.resolve();
        await release.promise;
        throw new Error("injected sync failure during deletion");
      });
      const record = toStoredAgentRecord(
        createManagedAgent({ id: "deleted-incoming", lifecycle: "closed" }),
      );
      const installed = storage.installHandoffRecord(record);
      await entered.promise;
      const removed = storage.remove(record.id);
      const outcomes = Promise.allSettled([installed, removed]);
      release.resolve();
      expect(await outcomes).toEqual([
        { status: "rejected", reason: new Error("injected sync failure during deletion") },
        { status: "fulfilled", value: undefined },
      ]);
      const reloaded = new AgentStorage(storagePath, logger);
      expect(await reloaded.get(record.id)).toBeNull();
    },
  );

  test.runIf(process.platform === "win32")(
    "an unsupported handoff checkpoint does not block later ordinary writes",
    async () => {
      await storage.applySnapshot(
        createManagedAgent({ id: "windows-checkpoint", lifecycle: "closed" }),
      );
      await expect(storage.checkpointClosedAgent("windows-checkpoint")).rejects.toThrow(
        "unavailable on Windows",
      );
      await storage.setTitle("windows-checkpoint", "Still editable");
      const reloaded = new AgentStorage(storagePath, logger);
      expect((await reloaded.get("windows-checkpoint"))?.title).toBe("Still editable");
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff checkpoint requires closed state and reports failed writes",
    async () => {
      await storage.applySnapshot(
        createManagedAgent({ id: "handoff-agent", workspaceId: "workspace-1" }),
      );
      await expect(storage.checkpointClosedAgent("handoff-agent")).rejects.toThrow(
        "requires a persisted closed agent",
      );
      await storage.applySnapshot(
        createManagedAgent({
          id: "handoff-agent",
          workspaceId: "workspace-1",
          lifecycle: "closed",
        }),
      );
      await fs.rm(storagePath, { recursive: true });
      await fs.writeFile(storagePath, "blocked storage directory");
      await expect(storage.checkpointClosedAgent("handoff-agent")).rejects.toThrow();
      await fs.rm(storagePath);
      await expect(storage.checkpointClosedAgent("handoff-agent")).resolves.toMatchObject({
        id: "handoff-agent",
        lastStatus: "closed",
      });
    },
  );

  test("internal flag is persisted and reloaded", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Reload the registry from disk
    const reloaded = new AgentStorage(storagePath, logger);
    const record = await reloaded.get("internal-agent");
    expect(record?.internal).toBe(true);

    // Registry returns all agents - filtering happens at manager level
    const records = await reloaded.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.internal).toBe(true);
  });

  test("Windows drive-letter paths produce valid directory names", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "win-agent",
        cwd: "D:\\Users\\dev\\MyProject",
      }),
    );

    const record = await storage.get("win-agent");
    expect(record).not.toBeNull();

    // The persisted directory must not contain a colon (invalid on Windows)
    const dirs = readdirSync(storagePath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain(":");
    expect(dirs[0]).toBe("D-Users-dev-MyProject");
  });

  test("remove deletes all duplicate record files across project directories", async () => {
    const agentId = "agent-duplicate";

    // Create a valid record file in two different project directories to simulate
    // storage migrations/duplication. Only one copy will be referenced in-memory,
    // but deletion should remove *all* copies on disk.
    const recordA = await (async () => {
      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          cwd: "/tmp/project-a",
          provider: "codex",
        }),
      );
      const record = await storage.get(agentId);
      expect(record).not.toBeNull();
      return record!;
    })();

    const projectDirB = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDirB, { recursive: true });
    const duplicatePathB = path.join(projectDirB, `${agentId}.json`);
    await fs.writeFile(
      duplicatePathB,
      JSON.stringify({ ...recordA, cwd: "/tmp/project-b" }, null, 2),
      "utf8",
    );

    // Force a reload so the registry has to discover from disk (and may choose either copy).
    const reloaded = new AgentStorage(storagePath, logger);
    const before = await reloaded.list();
    expect(before.map((r) => r.id)).toContain(agentId);

    await reloaded.remove(agentId);

    const hasAnyRecordFile = async () => {
      const projects = await fs
        .readdir(storagePath, { withFileTypes: true })
        .catch(() => [] as Awaited<ReturnType<typeof fs.readdir>>);
      const exists = await Promise.all(
        projects
          .filter((project) => project.isDirectory())
          .map(async (project) => {
            const candidate = path.join(storagePath, project.name, `${agentId}.json`);
            try {
              await fs.access(candidate);
              return true;
            } catch {
              return false;
            }
          }),
      );
      return exists.some((present) => present);
    };

    expect(await hasAnyRecordFile()).toBe(false);

    const afterReload = new AgentStorage(storagePath, logger);
    const after = await afterReload.list();
    expect(after.some((r) => r.id === agentId)).toBe(false);
  });
});
