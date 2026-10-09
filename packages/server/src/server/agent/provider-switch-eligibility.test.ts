import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import {
  collectProviderSwitchBlockers,
  collectProviderSwitchWorkBlockers,
  type ProviderSwitchWorkFacts,
} from "./provider-switch-eligibility.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
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
    ...overrides,
  };
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
    collectProviderSwitchWorkBlockers(quietFacts(), { ownsReplacementReservation: true }),
  ).toEqual([]);
});

test("a provider without a background-work probe is free to switch", async () => {
  expect(await collectProviderSwitchBlockers(quietFacts(), {})).toEqual([]);
  expect(await collectProviderSwitchBlockers(quietFacts(), null)).toEqual([]);
});

test("the provider probe runs only once the manager-side facts are quiet", async () => {
  let probes = 0;
  const session = {
    canEvictIdleBackend: async () => {
      probes += 1;
      return false;
    },
  };

  expect(await collectProviderSwitchBlockers(quietFacts({ hasRun: true }), session)).toEqual([
    { kind: "run_in_flight" },
  ]);
  expect(probes).toBe(0);
  expect(await collectProviderSwitchBlockers(quietFacts(), session)).toEqual([
    { kind: "provider_background_work" },
  ]);
  expect(probes).toBe(1);
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

test("a Claude runtime that never reported its inventory is a blocker", async () => {
  const feed = createFrameFeed();
  const { session, query } = await createScriptedClaudeSession(feed);
  try {
    const started = await session.startTurn("hello");
    feed.push(initFrame());
    feed.push(userReplayFrame(query.submittedUuid()));
    feed.push(resultFrame());
    expect(await started.submission).toBe("accepted");

    expect(await collectProviderSwitchBlockers(quietFacts(), session)).toEqual([
      { kind: "provider_background_work" },
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
