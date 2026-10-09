import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { startAgentRun } from "./agent-prompt.js";
import type { AgentRuntimeHold } from "./agent-sdk-types.js";
import {
  collectProviderSwitchBlockers,
  collectProviderSwitchWorkBlockers,
  isWaitableProviderSwitchBlocker,
  type ProviderSwitchBlocker,
  type ProviderSwitchWorkFacts,
} from "./provider-switch-eligibility.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { ClaudeRuntimeResidency } from "./providers/claude/runtime-residency.js";
import {
  createFrameFeed,
  createScriptedClaudeSession,
  initFrame,
  resultFrame,
  userReplayFrame,
} from "./providers/claude/test-utils/scripted-query.js";

function quietFacts(overrides: Partial<ProviderSwitchWorkFacts> = {}): ProviderSwitchWorkFacts {
  return {
    lifecycle: "idle",
    activeForegroundTurnId: null,
    activeTurnId: null,
    pendingReplacement: false,
    pendingPermissionCount: 0,
    inFlightPermissionResponseCount: 0,
    hasRun: false,
    hasInFlightOutOfBand: false,
    runningProviderSubagentCount: 0,
    runtimeRelease: "held",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test.each([
  ["idle with nothing in flight", quietFacts(), []],
  ["a settled error with no turn", quietFacts({ lifecycle: "error" }), []],
  ["a closed runtime", quietFacts({ lifecycle: "closed" }), []],
  ["still initializing", quietFacts({ lifecycle: "initializing" }), [{ kind: "initializing" }]],
  [
    "a foreground turn",
    quietFacts({ lifecycle: "running", activeForegroundTurnId: "turn-1", activeTurnId: "turn-1" }),
    [{ kind: "turn_active", turnId: "turn-1" }],
  ],
  [
    "an autonomous turn",
    quietFacts({ lifecycle: "running", activeTurnId: "auto-1" }),
    [{ kind: "turn_active", turnId: "auto-1" }],
  ],
  ["a tracked run", quietFacts({ hasRun: true }), [{ kind: "run_in_flight" }]],
  [
    "pending permissions",
    quietFacts({ pendingPermissionCount: 2 }),
    [{ kind: "permissions_pending", count: 2 }],
  ],
  [
    "permission responses in flight",
    quietFacts({ inFlightPermissionResponseCount: 1 }),
    [{ kind: "permission_responses_in_flight", count: 1 }],
  ],
  [
    "an out-of-band command",
    quietFacts({ hasInFlightOutOfBand: true }),
    [{ kind: "out_of_band_in_flight" }],
  ],
  [
    "a running provider subagent",
    quietFacts({ runningProviderSubagentCount: 3 }),
    [{ kind: "provider_subagents_running", count: 3 }],
  ],
  [
    "a close that failed and still owns the runtime",
    quietFacts({ lifecycle: "error", runtimeRelease: "failed" }),
    [{ kind: "runtime_release_unproven", state: "failed" }],
  ],
  [
    "a close still in flight",
    quietFacts({ runtimeRelease: "pending" }),
    [{ kind: "runtime_release_unproven", state: "pending" }],
  ],
])("reports %s", (_label, facts, expected) => {
  expect(collectProviderSwitchWorkBlockers(facts)).toEqual(expected);
});

test("a replacement reservation blocks every operation except the one that owns it", () => {
  const heldForReplacement = quietFacts({ lifecycle: "running", pendingReplacement: true });

  expect(collectProviderSwitchWorkBlockers(heldForReplacement)).toEqual([
    { kind: "turn_active", turnId: null },
    { kind: "replacement_reserved" },
  ]);
  expect(
    collectProviderSwitchWorkBlockers(heldForReplacement, { ownsReplacementReservation: true }),
  ).toEqual([]);
  expect(
    collectProviderSwitchWorkBlockers(
      { ...heldForReplacement, hasRun: true },
      { ownsReplacementReservation: true },
    ),
  ).toEqual([{ kind: "run_in_flight" }]);
  expect(
    collectProviderSwitchWorkBlockers(
      { ...heldForReplacement, runtimeRelease: "failed" },
      { ownsReplacementReservation: true },
    ),
  ).toEqual([{ kind: "runtime_release_unproven", state: "failed" }]);
  expect(
    collectProviderSwitchWorkBlockers(quietFacts(), { ownsReplacementReservation: true }),
  ).toEqual([]);
});

test("a provider without a background-work probe is free to switch", async () => {
  expect(await collectProviderSwitchBlockers(quietFacts(), {})).toEqual([]);
  expect(await collectProviderSwitchBlockers(quietFacts(), null)).toEqual([]);
});

test("manager-side work wins over the provider probe", async () => {
  const session = {
    canEvictIdleBackend: async () => false,
  };

  expect(await collectProviderSwitchBlockers(quietFacts({ hasRun: true }), session)).toEqual([
    { kind: "run_in_flight" },
  ]);
  expect(await collectProviderSwitchBlockers(quietFacts(), session)).toEqual([
    { kind: "provider_background_work" },
  ]);
});

test("a probe that cannot answer is reported, not waited on", async () => {
  const session = {
    canEvictIdleBackend: async () => {
      throw new Error("inventory not reported yet");
    },
  };

  expect(await collectProviderSwitchBlockers(quietFacts(), session)).toEqual([
    { kind: "provider_background_unverified", reason: "inventory not reported yet" },
  ]);
});

test("typed provider holds are preferred over the boolean probe and keep their nature", async () => {
  const holds: AgentRuntimeHold[] = [
    { kind: "background_work", taskIds: ["shell-1"] },
    { kind: "session_crons", count: 1, recurring: false },
    { kind: "inventory_unknown" },
    { kind: "session_permissions" },
  ];
  const session = {
    canEvictIdleBackend: async () => false,
    describeRuntimeHolds: async () => holds,
  };

  const blockers = await collectProviderSwitchBlockers(quietFacts(), session);

  expect(blockers).toEqual(holds.map((hold) => ({ kind: "provider_runtime_hold", hold })));
  expect(blockers.map(isWaitableProviderSwitchBlocker)).toEqual([true, true, false, false]);
  expect(
    await collectProviderSwitchBlockers(quietFacts(), { describeRuntimeHolds: async () => [] }),
  ).toEqual([]);
});

test.each<[string, ProviderSwitchBlocker, boolean]>([
  ["a foreground turn", { kind: "turn_active", turnId: "turn-1" }, true],
  ["pending permissions", { kind: "permissions_pending", count: 1 }, true],
  ["running provider subagents", { kind: "provider_subagents_running", count: 1 }, true],
  ["a replacement reservation", { kind: "replacement_reserved" }, true],
  ["an unreleased runtime", { kind: "runtime_release_unproven", state: "failed" }, false],
  [
    "a recurring session cron",
    { kind: "provider_runtime_hold", hold: { kind: "session_crons", count: 1, recurring: true } },
    false,
  ],
  [
    "a cron whose schedule kind is unknown",
    { kind: "provider_runtime_hold", hold: { kind: "session_crons", count: 1, recurring: null } },
    false,
  ],
  ["an unexplained provider refusal", { kind: "provider_background_work" }, false],
  ["an unverifiable provider", { kind: "provider_background_unverified", reason: "x" }, false],
])("%s is %s", (_label, blocker, waitable) => {
  expect(isWaitableProviderSwitchBlocker(blocker)).toBe(waitable);
});

test("a recurring Claude cron is never offered as finite work to wait for", async () => {
  const residency = new ClaudeRuntimeResidency();
  residency.observeStopHook({
    hook_event_name: "Stop",
    background_tasks: [],
    session_crons: [{ id: "repeat", schedule: "* * * * *", recurring: true, prompt: "poll" }],
  });
  const session = { describeRuntimeHolds: async () => residency.holds() };

  const blockers = await collectProviderSwitchBlockers(quietFacts(), session);

  expect(blockers).toEqual([
    { kind: "provider_runtime_hold", hold: { kind: "session_crons", count: 1, recurring: true } },
  ]);
  expect(blockers.map(isWaitableProviderSwitchBlocker)).toEqual([false]);
});

test("a Claude runtime reports what still holds it instead of a bare refusal", async () => {
  const feed = createFrameFeed();
  const { session, query } = await createScriptedClaudeSession(feed);
  try {
    const started = await session.startTurn("hello");
    feed.push(initFrame());
    feed.push(userReplayFrame(query.submittedUuid()));
    feed.push(resultFrame());
    expect(await started.submission).toBe("accepted");

    expect(await collectProviderSwitchBlockers(quietFacts(), session)).toEqual([
      { kind: "provider_runtime_hold", hold: { kind: "inventory_unknown" } },
    ]);

    feed.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "shell-1", task_type: "local_bash", description: "npm test" }],
      session_id: "scripted-session",
    });
    await feed.drained();
    expect(await collectProviderSwitchBlockers(quietFacts(), session)).toEqual([
      { kind: "provider_runtime_hold", hold: { kind: "background_work", taskIds: ["shell-1"] } },
      { kind: "provider_runtime_hold", hold: { kind: "inventory_unknown" } },
    ]);
  } finally {
    await session.close();
  }
});

test("an idle Codex agent can switch even with idle eviction disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "switch-eligibility-"));
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    idleRuntimeTimeoutMs: 0,
    logger: createTestLogger(),
  });
  const agentId = "00000000-0000-4000-8000-000000000701";

  try {
    await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: undefined,
    });

    expect(await manager.getProviderSwitchBlockers(agentId)).toEqual([]);
    expect(await manager.getProviderSwitchBlockers("00000000-0000-4000-8000-000000000799")).toEqual(
      [],
    );
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn that failed leaves a settled error that can still switch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "switch-eligibility-error-"));
  const logger = createTestLogger();
  const manager = new AgentManager({ clients: createTestAgentClients(), logger });
  const agentId = "00000000-0000-4000-8000-000000000702";

  try {
    await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: undefined,
    });
    await startAgentRun(manager, agentId, "please emit a turn failure", logger, {});
    const settled = await manager.waitForAgentEvent(agentId);
    expect(settled.status).toBe("error");

    expect(await manager.getProviderSwitchBlockers(agentId)).toEqual([]);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a close that failed keeps the runtime unreleased and blocks the switch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "switch-eligibility-failed-close-"));
  const manager = new AgentManager({
    clients: createTestAgentClients({
      closeSession: async () => {
        throw new Error("provider cleanup failed");
      },
    }),
    logger: createTestLogger(),
  });
  const agentId = "00000000-0000-4000-8000-000000000703";

  try {
    await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: undefined,
    });

    await expect(manager.reloadAgentSession(agentId)).rejects.toThrow("provider cleanup failed");
    expect(manager.getAgent(agentId)?.lifecycle).toBe("error");
    expect(await manager.getProviderSwitchBlockers(agentId)).toEqual([
      { kind: "runtime_release_unproven", state: "failed" },
    ]);

    await expect(manager.closeAgent(agentId)).rejects.toThrow("provider cleanup failed");
    expect(await manager.getProviderSwitchBlockers(agentId)).toEqual([
      { kind: "runtime_release_unproven", state: "failed" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a close still in flight blocks the switch until the runtime is released", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "switch-eligibility-pending-close-"));
  const closeEntered = deferred<void>();
  const closeReleased = deferred<void>();
  const manager = new AgentManager({
    clients: createTestAgentClients({
      closeSession: async () => {
        closeEntered.resolve();
        await closeReleased.promise;
      },
    }),
    logger: createTestLogger(),
  });
  const agentId = "00000000-0000-4000-8000-000000000704";

  try {
    await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: undefined,
    });

    const closing = manager.closeAgent(agentId);
    await closeEntered.promise;
    expect(await manager.getProviderSwitchBlockers(agentId)).toEqual([
      { kind: "runtime_release_unproven", state: "pending" },
    ]);

    closeReleased.resolve();
    await closing;
    expect(manager.getAgent(agentId)).toBeNull();
    expect(await manager.getProviderSwitchBlockers(agentId)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
