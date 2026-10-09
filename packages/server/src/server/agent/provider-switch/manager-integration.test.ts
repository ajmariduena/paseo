import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { AgentManager } from "../agent-manager.js";
import { startAgentRun } from "../agent-prompt.js";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import { AgentStorage, type StoredAgentRecord } from "../agent-storage.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import type { ProviderSegment } from "./record.js";
import { SegmentSnapshotStore } from "./snapshot-store.js";
import { StaleAgentHandleError } from "./stale-handle-error.js";

const T0 = "2026-10-09T10:00:00.000Z";
const T1 = "2026-10-09T11:00:00.000Z";

interface Harness {
  root: string;
  storage: AgentStorage;
  snapshots: SegmentSnapshotStore;
  manager: AgentManager;
  clients: Record<string, AgentClient>;
  cleanup(): Promise<void>;
}

async function createHarness(clients?: Record<string, AgentClient>): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "switch-manager-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const snapshots = new SegmentSnapshotStore(path.join(root, "context", "segments"));
  const resolvedClients = clients ?? createTestAgentClients();
  const manager = new AgentManager({
    clients: resolvedClients,
    registry: storage,
    segmentSnapshots: snapshots,
    logger,
  });
  return {
    root,
    storage,
    snapshots,
    manager,
    clients: resolvedClients,
    async cleanup() {
      manager.prepareForShutdown();
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function reopen(harness: Harness): AgentManager {
  return new AgentManager({
    clients: harness.clients,
    registry: harness.storage,
    segmentSnapshots: harness.snapshots,
    logger: createTestLogger(),
  });
}

function retiredSegment(provider: string, incarnationId: string): ProviderSegment {
  return {
    id: `seg-${incarnationId}`,
    provider,
    model: null,
    modeId: null,
    thinkingOptionId: null,
    incarnations: [
      {
        id: incarnationId,
        persistence: { provider, sessionId: `old-${incarnationId}` },
        startedAt: T0,
        endedAt: T1,
        reason: "switch",
        snapshotId: incarnationId,
        rowCount: 1,
        coverage: "complete",
        firstAcceptedAt: T0,
        unresolvedAttemptId: null,
      },
    ],
    startedAt: T0,
    endedAt: T1,
    handoffId: null,
    requestedBy: "user",
    operationId: "op-1",
  };
}

function activeSegmentFor(
  record: StoredAgentRecord,
  firstAcceptedAt: string | null,
): ProviderSegment {
  return {
    id: "seg-active",
    provider: record.provider,
    model: record.config?.model ?? null,
    modeId: record.config?.modeId ?? null,
    thinkingOptionId: null,
    incarnations: [
      {
        id: "inc-active",
        persistence: record.persistence ?? null,
        startedAt: T1,
        endedAt: null,
        reason: "switch",
        snapshotId: null,
        rowCount: null,
        coverage: null,
        firstAcceptedAt,
        unresolvedAttemptId: null,
      },
    ],
    startedAt: T1,
    endedAt: null,
    handoffId: "handoff-1",
    requestedBy: "user",
    operationId: "op-1",
  };
}

/** Writes a retired Claude segment with one sealed row behind a live Codex agent. */
async function switchedRecord(harness: Harness, agentId: string): Promise<StoredAgentRecord> {
  const stored = await harness.storage.get(agentId);
  if (!stored) throw new Error("expected a stored agent");
  await harness.snapshots.seal({
    agentId,
    segmentId: "seg-inc-claude",
    incarnationId: "inc-claude",
    provider: "claude",
    model: null,
    rows: [{ seq: 1, timestamp: T0, item: { type: "assistant_message", text: "from claude" } }],
    childPanes: [],
    sealedAt: T1,
  });
  const record: StoredAgentRecord = {
    ...stored,
    providerSegments: [retiredSegment("claude", "inc-claude"), activeSegmentFor(stored, T1)],
  };
  await harness.storage.upsert(record);
  return record;
}

async function runTurn(manager: AgentManager, agentId: string, prompt: string): Promise<string> {
  const logger = createTestLogger();
  await startAgentRun(manager, agentId, prompt, logger, {});
  const settled = await manager.waitForAgentEvent(agentId, { waitForActive: true });
  expect(settled.status).toBe("idle");
  if (!settled.lastMessage) throw new Error("expected the fake provider to answer");
  return settled.lastMessage;
}

function texts(manager: AgentManager, agentId: string): string[] {
  return manager.getTimeline(agentId).map((item) => {
    if (item.type === "notification") return `[${item.source?.kind ?? "notification"}]`;
    return item.type === "assistant_message" || item.type === "user_message"
      ? item.text
      : item.type;
  });
}

test("a snapshot flush keeps the segments a record already carries", async () => {
  const harness = await createHarness();
  const agentId = "00000000-0000-4000-8000-000000000801";
  try {
    await harness.manager.createAgent({ provider: "codex", cwd: harness.root }, agentId, {
      workspaceId: undefined,
    });
    await harness.manager.flush();
    await harness.storage.flush();
    const record = await switchedRecord(harness, agentId);

    await harness.manager.appendTimelineItem(agentId, { type: "assistant_message", text: "later" });
    await harness.manager.flush();
    await harness.storage.flush();

    expect((await harness.storage.get(agentId))?.providerSegments).toEqual(record.providerSegments);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a restart seeds the retired history, the divider and then the live replay", async () => {
  const harness = await createHarness();
  const agentId = "00000000-0000-4000-8000-000000000802";
  const logger = createTestLogger();
  try {
    await harness.manager.createAgent({ provider: "codex", cwd: harness.root }, agentId, {
      workspaceId: undefined,
    });
    const reply = await runTurn(harness.manager, agentId, "hello codex");
    await harness.manager.closeAgent(agentId);
    await harness.manager.flush();
    await harness.storage.flush();
    await switchedRecord(harness, agentId);

    const restarted = reopen(harness);
    await ensureAgentLoaded(agentId, {
      agentManager: restarted,
      agentStorage: harness.storage,
      logger,
    });

    const timeline = texts(restarted, agentId);
    expect(timeline.slice(0, 2)).toEqual(["from claude", "[provider_switch]"]);
    expect(timeline.slice(2)).toContain(reply);
    expect(restarted.getAgent(agentId)?.providerSegments?.map((segment) => segment.id)).toEqual([
      "seg-inc-claude",
      "seg-active",
    ]);
    await restarted.closeAgent(agentId);
    restarted.prepareForShutdown();
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("evicting and reopening keeps every row and the epoch; only a rebuild re-seeds", async () => {
  const harness = await createHarness();
  const agentId = "00000000-0000-4000-8000-000000000803";
  const logger = createTestLogger();
  try {
    await harness.manager.createAgent({ provider: "codex", cwd: harness.root }, agentId, {
      workspaceId: undefined,
    });
    await harness.manager.closeAgent(agentId);
    await harness.manager.flush();
    await harness.storage.flush();
    await switchedRecord(harness, agentId);

    const restarted = reopen(harness);
    await ensureAgentLoaded(agentId, {
      agentManager: restarted,
      agentStorage: harness.storage,
      logger,
    });
    const reply = await runTurn(restarted, agentId, "after the switch");
    const epoch = restarted.fetchTimeline(agentId).epoch;
    const rowsBefore = texts(restarted, agentId);
    expect(rowsBefore.slice(0, 2)).toEqual(["from claude", "[provider_switch]"]);
    expect(rowsBefore).toContain(reply);

    await restarted.closeAgent(agentId);
    await ensureAgentLoaded(agentId, {
      agentManager: restarted,
      agentStorage: harness.storage,
      logger,
    });

    expect(restarted.fetchTimeline(agentId).epoch).toBe(epoch);
    expect(texts(restarted, agentId)).toEqual(rowsBefore);

    await restarted.reloadAgentSession(agentId, undefined, { rehydrateFromDisk: true });
    await restarted.hydrateTimelineFromProvider(agentId, { broadcast: true });
    expect(restarted.fetchTimeline(agentId).epoch).not.toBe(epoch);
    const rebuilt = texts(restarted, agentId);
    expect(rebuilt.slice(0, 2)).toEqual(["from claude", "[provider_switch]"]);
    expect(rebuilt.filter((text) => text === "from claude")).toHaveLength(1);
    expect(rebuilt).toContain(reply);

    await restarted.closeAgent(agentId);
    restarted.prepareForShutdown();
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a resume with a handle the record no longer runs on is rejected", async () => {
  const harness = await createHarness();
  const agentId = "00000000-0000-4000-8000-000000000804";
  try {
    const created = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: undefined },
    );
    await harness.manager.closeAgent(agentId);
    await harness.manager.flush();
    await harness.storage.flush();
    await switchedRecord(harness, agentId);
    if (!created.persistence) throw new Error("expected a handle");

    await expect(
      harness.manager.resumeAgentFromPersistence(
        { provider: "codex", sessionId: "old-inc-claude" },
        undefined,
        agentId,
      ),
    ).rejects.toBeInstanceOf(StaleAgentHandleError);
    expect(harness.manager.getAgent(agentId)).toBeNull();

    const resumed = await harness.manager.resumeAgentFromPersistence(
      created.persistence,
      undefined,
      agentId,
    );
    expect(resumed.persistence?.sessionId).toBe(created.persistence.sessionId);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a loader that read the record before the switch committed retries with the new one", async () => {
  const base = await createHarness();
  const agentId = "00000000-0000-4000-8000-000000000805";
  const logger = createTestLogger();
  try {
    const created = await base.manager.createAgent({ provider: "codex", cwd: base.root }, agentId, {
      workspaceId: undefined,
    });
    await base.manager.closeAgent(agentId);
    await base.manager.flush();
    await base.storage.flush();
    const committed = await switchedRecord(base, agentId);

    // The first read answers with the record as it was before the switch: the retired
    // Claude incarnation still active, under its old handle.
    let staleReads = 1;
    const storage = new (class extends AgentStorage {
      override async get(id: string): Promise<StoredAgentRecord | null> {
        const record = await super.get(id);
        if (!record || staleReads === 0) return record;
        staleReads -= 1;
        return {
          ...record,
          provider: "claude",
          persistence: { provider: "claude", sessionId: "old-inc-claude" },
          providerSegments: [
            {
              ...retiredSegment("claude", "inc-claude"),
              endedAt: null,
              incarnations: [
                { ...retiredSegment("claude", "inc-claude").incarnations[0], endedAt: null },
              ],
            },
          ],
        };
      }
    })(path.join(base.root, "agents"), logger);
    const manager = new AgentManager({
      clients: base.clients,
      registry: storage,
      segmentSnapshots: base.snapshots,
      logger,
    });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(loaded.provider).toBe("codex");
    expect(loaded.persistence?.sessionId).toBe(created.persistence?.sessionId);
    expect(loaded.providerSegments).toEqual(committed.providerSegments);
    await manager.closeAgent(agentId);
    manager.prepareForShutdown();
  } finally {
    await base.manager.closeAgent(agentId).catch(() => undefined);
    await base.cleanup();
  }
});

test("an incarnation that never accepted a turn restores fresh under its reserved id", async () => {
  const createOptions: Array<AgentCreateSessionOptions | undefined> = [];
  const resumes: string[] = [];
  const fake = createTestAgentClients().codex;
  if (!fake) throw new Error("expected a Codex test client");
  const recording: AgentClient = {
    provider: fake.provider,
    capabilities: fake.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
      options?: AgentCreateSessionOptions,
    ): Promise<AgentSession> => {
      createOptions.push(options);
      return await fake.createSession(config, launchContext, options);
    },
    resumeSession: async (handle, overrides, launchContext) => {
      resumes.push(handle.sessionId);
      return await fake.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await fake.fetchCatalog(options),
    isAvailable: async () => await fake.isAvailable(),
  };
  const harness = await createHarness({ codex: recording });
  const agentId = "00000000-0000-4000-8000-000000000806";
  const logger = createTestLogger();
  try {
    await harness.manager.createAgent({ provider: "codex", cwd: harness.root }, agentId, {
      workspaceId: undefined,
    });
    await harness.manager.closeAgent(agentId);
    await harness.manager.flush();
    await harness.storage.flush();
    const stored = await harness.storage.get(agentId);
    if (!stored) throw new Error("expected a stored agent");
    const reserved = { provider: "codex", sessionId: "thread-reserved" };
    await harness.storage.upsert({
      ...stored,
      persistence: null,
      providerSegments: [activeSegmentFor({ ...stored, persistence: reserved }, null)],
    });
    createOptions.length = 0;
    resumes.length = 0;

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: harness.manager,
      agentStorage: harness.storage,
      logger,
    });

    expect(resumes).toEqual([]);
    expect(createOptions).toEqual([{ reservedSessionId: "thread-reserved" }]);
    expect(loaded.createdAt.toISOString()).toBe(stored.createdAt);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});
