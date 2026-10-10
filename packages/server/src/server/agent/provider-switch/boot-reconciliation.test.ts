import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentStorage, type StoredAgentRecord } from "../agent-storage.js";
import { reconcileProviderSwitchesAtBoot } from "./boot-reconciliation.js";
import { HandoffStore } from "./handoff-store.js";
import type { ProviderSegment, SwitchOperation } from "./record.js";
import { SegmentSnapshotStore } from "./snapshot-store.js";

const NOW = "2026-10-09T12:00:00.000Z";
const LATER = "2026-10-09T12:05:00.000Z";

let root: string;
let storage: AgentStorage;
let snapshots: SegmentSnapshotStore;
let handoffs: HandoffStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "switch-boot-"));
  storage = new AgentStorage(join(root, "agents"), createTestLogger());
  snapshots = new SegmentSnapshotStore(join(root, "context", "segments"));
  handoffs = new HandoffStore(join(root, "context", "handoffs"));
  await storage.initialize();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(id: string, overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id,
    provider: "claude",
    cwd: root,
    createdAt: NOW,
    updatedAt: NOW,
    labels: {},
    lastStatus: "closed",
    config: null,
    persistence: { provider: "claude", sessionId: "session-a" },
    ...overrides,
  };
}

function segment(id: string, snapshotId: string | null, handoffId: string | null): ProviderSegment {
  return {
    id,
    provider: "claude",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    incarnations: [
      {
        id: `inc-${id}`,
        persistence: { provider: "claude", sessionId: `session-${id}` },
        startedAt: NOW,
        endedAt: null,
        reason: "switch",
        snapshotId,
        rowCount: null,
        coverage: null,
        firstAcceptedAt: NOW,
        unresolvedAttemptId: null,
      },
    ],
    startedAt: NOW,
    endedAt: null,
    handoffId,
    requestedBy: "user",
    operationId: `op-${id}`,
  };
}

function operation(
  phase: SwitchOperation["phase"],
  overrides: Partial<SwitchOperation> = {},
): SwitchOperation {
  return {
    operationId: `op-${phase}`,
    clientOperationId: `client-${phase}`,
    fingerprint: "fp",
    phase,
    sourceSegmentId: "seg-a",
    targetSegmentId: null,
    sealedSnapshotId: null,
    allocatedHandle: null,
    result: null,
    error: null,
    updatedAt: NOW,
    ...overrides,
  };
}

async function seal(agentId: string, incarnationId: string): Promise<void> {
  await snapshots.seal({
    agentId,
    segmentId: "seg-a",
    incarnationId,
    provider: "claude",
    model: null,
    rows: [],
    childPanes: [],
    sealedAt: NOW,
  });
}

function reconcile() {
  return reconcileProviderSwitchesAtBoot({
    storage,
    snapshots,
    handoffs,
    logger: createTestLogger(),
    now: () => LATER,
  });
}

test.each<[SwitchOperation["phase"], "failed" | "done"]>([
  ["planned", "failed"],
  ["draining", "failed"],
  ["sealed", "failed"],
  ["allocated", "failed"],
  ["committed", "done"],
])("an operation cut while %s settles as %s with one record write", async (phase, outcome) => {
  await storage.upsert(
    record("agent-1", {
      switchOperations: [
        operation(phase, {
          sealedSnapshotId: phase === "sealed" || phase === "allocated" ? "inc-x" : null,
          allocatedHandle:
            phase === "allocated" ? { provider: "codex", sessionId: "thread-orphan" } : null,
        }),
        operation("done", { operationId: "op-earlier" }),
      ],
    }),
  );

  const summary = await reconcile();

  const stored = await storage.get("agent-1");
  const settled = stored?.switchOperations?.find((entry) => entry.operationId === `op-${phase}`);
  expect(settled).toMatchObject({ phase: outcome, updatedAt: LATER });
  expect(settled?.error).toBe(
    outcome === "failed" ? `Interrupted by a daemon restart while ${phase}` : null,
  );
  expect(stored?.switchOperations?.find((entry) => entry.operationId === "op-earlier")).toEqual(
    operation("done", { operationId: "op-earlier" }),
  );
  if (outcome === "failed") {
    expect(summary.failed).toEqual([
      { agentId: "agent-1", operationId: `op-${phase}`, phase: "failed" },
    ]);
    expect(summary.completed).toEqual([]);
  } else {
    expect(summary.completed).toEqual([{ agentId: "agent-1", operationId: `op-${phase}` }]);
    expect(summary.failed).toEqual([]);
  }
  // Allocation left a native session behind; the record still names it so PS-3 can clean up.
  expect(settled?.allocatedHandle).toEqual(
    phase === "allocated" ? { provider: "codex", sessionId: "thread-orphan" } : null,
  );
});

test("a second boot finds nothing left to settle", async () => {
  await storage.upsert(record("agent-1", { switchOperations: [operation("sealed")] }));

  await reconcile();
  const second = await reconcile();

  expect(second.failed).toEqual([]);
  expect(second.completed).toEqual([]);
});

test("history of an agent whose record cannot be read is never swept", async () => {
  await storage.upsert(record("agent-ok"));
  await storage.flush();
  mkdirSync(join(root, "agents", "broken"), { recursive: true });
  writeFileSync(join(root, "agents", "broken", "agent-broken.json"), "{ not json");
  await seal("agent-broken", "retired");
  await seal("agent-gone", "gone");
  const fresh = new AgentStorage(join(root, "agents"), createTestLogger());
  await fresh.initialize();

  const summary = await reconcileProviderSwitchesAtBoot({
    storage: fresh,
    snapshots,
    handoffs,
    logger: createTestLogger(),
    now: () => LATER,
  });

  expect(summary.orphanSnapshots).toEqual([{ agentId: "agent-gone", incarnationId: "gone" }]);
  expect(summary.unreadableRecords).toEqual(["agent-broken"]);
  expect(await snapshots.read("agent-broken", "retired")).not.toBeNull();
});

test("a record repaired after storage loaded keeps the snapshots it references", async () => {
  const brokenDir = join(root, "agents", "repaired");
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, "agent-repaired.json"), "{ not json");
  await seal("agent-repaired", "inc-kept");
  await seal("agent-repaired", "inc-orphan");
  const fresh = new AgentStorage(join(root, "agents"), createTestLogger());
  await fresh.initialize();
  writeFileSync(
    join(brokenDir, "agent-repaired.json"),
    JSON.stringify(
      record("agent-repaired", {
        cwd: "/tmp/repaired",
        providerSegments: [segment("seg-a", "inc-kept", null)],
      }),
    ),
  );

  const summary = await reconcileProviderSwitchesAtBoot({
    storage: fresh,
    snapshots,
    handoffs,
    logger: createTestLogger(),
    now: () => LATER,
  });

  expect(summary.sweep).toBe("done");
  expect(summary.orphanSnapshots).toEqual([
    { agentId: "agent-repaired", incarnationId: "inc-orphan" },
  ]);
  expect(await snapshots.read("agent-repaired", "inc-kept")).not.toBeNull();
});

test("a record repaired after storage loaded settles its operation from the file, not the cache", async () => {
  const dir = join(root, "agents", "tmp-repaired-op");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-op.json"), "{ not json");
  await seal("agent-op", "inc-kept");
  const fresh = new AgentStorage(join(root, "agents"), createTestLogger());
  await fresh.initialize();
  writeFileSync(
    join(dir, "agent-op.json"),
    JSON.stringify(
      record("agent-op", {
        cwd: "/tmp/repaired-op",
        providerSegments: [segment("seg-a", "inc-kept", null)],
        switchOperations: [operation("committed")],
      }),
    ),
  );

  const summary = await reconcileProviderSwitchesAtBoot({
    storage: fresh,
    snapshots,
    handoffs,
    logger: createTestLogger(),
    now: () => LATER,
  });

  expect(summary.recoveryFailed).toEqual([]);
  expect(summary.completed).toEqual([{ agentId: "agent-op", operationId: "op-committed" }]);
  expect(summary.orphanSnapshots).toEqual([]);
  expect(await snapshots.read("agent-op", "inc-kept")).not.toBeNull();
  const onDisk = JSON.parse(readFileSync(join(dir, "agent-op.json"), "utf8")) as StoredAgentRecord;
  expect(onDisk.switchOperations?.[0]).toMatchObject({ phase: "done", updatedAt: LATER });
  expect(onDisk.providerSegments?.[0].id).toBe("seg-a");
  expect((await fresh.get("agent-op"))?.switchOperations?.[0].phase).toBe("done");
});

test("a record replaced on disk after storage loaded is settled and swept from the file", async () => {
  await storage.upsert(record("agent-replaced", { cwd: "/tmp/replaced" }));
  await storage.flush();
  const fresh = new AgentStorage(join(root, "agents"), createTestLogger());
  await fresh.initialize();
  await seal("agent-replaced", "inc-kept");
  const filePath = join(root, "agents", "tmp-replaced", "agent-replaced.json");
  writeFileSync(
    filePath,
    JSON.stringify(
      record("agent-replaced", {
        cwd: "/tmp/replaced",
        providerSegments: [segment("seg-a", "inc-kept", null)],
        switchOperations: [operation("committed")],
      }),
    ),
  );

  const summary = await reconcileProviderSwitchesAtBoot({
    storage: fresh,
    snapshots,
    handoffs,
    logger: createTestLogger(),
    now: () => LATER,
  });

  expect(summary.recoveryFailed).toEqual([]);
  expect(summary.completed).toEqual([{ agentId: "agent-replaced", operationId: "op-committed" }]);
  expect(summary.orphanSnapshots).toEqual([]);
  expect(await snapshots.read("agent-replaced", "inc-kept")).not.toBeNull();
  const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as StoredAgentRecord;
  expect(onDisk.providerSegments?.[0].id).toBe("seg-a");
  expect(onDisk.switchOperations?.[0]).toMatchObject({ phase: "done", updatedAt: LATER });
  expect((await fresh.get("agent-replaced"))?.providerSegments?.[0].id).toBe("seg-a");
});

test("a record scan that cannot complete sweeps nothing", async () => {
  await storage.upsert(record("agent-ok"));
  await storage.flush();
  await seal("agent-gone", "gone");
  const blocked = join(root, "agents", "blocked");
  mkdirSync(blocked, { recursive: true });
  chmodSync(blocked, 0o000);
  const fresh = new AgentStorage(join(root, "agents"), createTestLogger());
  try {
    await fresh.initialize();
    const summary = await reconcileProviderSwitchesAtBoot({
      storage: fresh,
      snapshots,
      handoffs,
      logger: createTestLogger(),
      now: () => LATER,
    });

    expect(summary.sweep).toBe("skipped_incomplete_scan");
    expect(summary.orphanSnapshots).toEqual([]);
    expect(await snapshots.read("agent-gone", "gone")).not.toBeNull();
  } finally {
    chmodSync(blocked, 0o700);
  }
});

test("a record write that fails leaves that agent for the boot barrier and settles the rest", async () => {
  await storage.upsert(record("agent-1", { switchOperations: [operation("sealed")] }));
  await storage.upsert(record("agent-2", { switchOperations: [operation("allocated")] }));
  const failing = new (class extends AgentStorage {
    override async commitProviderSwitch(
      agentId: string,
      build: Parameters<AgentStorage["commitProviderSwitch"]>[1],
    ): Promise<StoredAgentRecord> {
      if (agentId === "agent-1") throw new Error("disk full");
      return await super.commitProviderSwitch(agentId, build);
    }
  })(join(root, "agents"), createTestLogger());
  await storage.flush();
  await failing.initialize();

  const summary = await reconcileProviderSwitchesAtBoot({
    storage: failing,
    snapshots,
    handoffs,
    logger: createTestLogger(),
    now: () => LATER,
  });

  expect(summary.recoveryFailed).toEqual([{ agentId: "agent-1", error: "disk full" }]);
  expect(summary.failed).toEqual([
    { agentId: "agent-2", operationId: "op-allocated", phase: "failed" },
  ]);
  expect((await failing.get("agent-1"))?.switchOperations?.[0].phase).toBe("sealed");
  expect((await failing.get("agent-2"))?.switchOperations?.[0].phase).toBe("failed");
});

test("snapshots and handoffs nothing references are swept; referenced ones stay", async () => {
  await storage.upsert(
    record("agent-1", {
      providerSegments: [segment("seg-a", "inc-kept", "handoff-kept")],
      switchOperations: [
        operation("done", {
          result: {
            targetSegmentId: "seg-b",
            targetIncarnationId: "inc-b",
            handoffId: "handoff-op",
          },
        }),
      ],
    }),
  );
  await seal("agent-1", "inc-kept");
  await seal("agent-1", "inc-orphan");
  await seal("agent-gone", "inc-gone");
  for (const [agentId, handoffId] of [
    ["agent-1", "handoff-kept"],
    ["agent-1", "handoff-op"],
    ["agent-1", "handoff-orphan"],
    ["agent-gone", "handoff-gone"],
  ] as const) {
    await handoffs.create({
      id: handoffId,
      agentId,
      fromSegmentId: "seg-a",
      toSegmentId: "seg-b",
      toIncarnationId: "inc-b",
      items: [],
      omittedItems: [],
      coverage: { text: "", ranges: [], missing: [], collapsed: false },
      budget: {
        available: 0,
        cap: 0,
        contextWindow: 0,
        unknownWindow: true,
        occupancy: 0,
        currentInput: 0,
        reserve: 0,
      },
      cost: 0,
      delivery: { state: "unsent", attemptId: null, updatedAt: NOW },
      createdAt: NOW,
    });
  }

  const summary = await reconcile();

  expect(summary.orphanSnapshots).toEqual([
    { agentId: "agent-1", incarnationId: "inc-orphan" },
    { agentId: "agent-gone", incarnationId: "inc-gone" },
  ]);
  expect(summary.orphanHandoffs).toEqual([
    { agentId: "agent-1", handoffId: "handoff-orphan" },
    { agentId: "agent-gone", handoffId: "handoff-gone" },
  ]);
  expect(await snapshots.listIncarnations("agent-1")).toEqual(["inc-kept"]);
  expect(await snapshots.listAgents()).toEqual(["agent-1"]);
  expect(await handoffs.list("agent-1")).toEqual(["handoff-kept", "handoff-op"]);
  expect(await handoffs.listAgents()).toEqual(["agent-1"]);
});
