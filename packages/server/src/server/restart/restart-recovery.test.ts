import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { MessageReceipts } from "../message-receipts/index.js";
import {
  createControlledHost,
  type ControlledHost,
} from "../test-utils/controlled-agent-client.js";

import type { StoredAgentRecord } from "../agent/agent-storage.js";
import {
  cancelledWorkFromTasks,
  prependRestartNote,
  restartCancelledWorkNote,
} from "./background-note.js";
import { RestartIntentStore, type CutRun } from "./restart-intent-store.js";
import {
  RestartRecovery,
  decideContinuation,
  type ContinuationDecision,
} from "./restart-recovery.js";

const CUT: CutRun = {
  agentId: "agent-1",
  provider: "claude",
  runKey: "run-1",
  cutAt: "2026-10-04T12:00:00.000Z",
  stopRequested: false,
  outOfBand: false,
};

const RECORD: StoredAgentRecord = {
  id: "agent-1",
  provider: "claude",
  cwd: "/tmp/project",
  createdAt: "2026-10-04T11:00:00.000Z",
  updatedAt: "2026-10-04T12:00:00.000Z",
  lastUserMessageAt: "2026-10-04T11:59:00.000Z",
  labels: {},
  lastStatus: "closed",
  config: null,
  persistence: { provider: "claude", sessionId: "session-1" },
};

test.each<[string, Parameters<typeof decideContinuation>[0], ContinuationDecision]>([
  ["a cut turn", { enabled: true, cut: CUT, record: RECORD }, { continue: true }],
  [
    "the setting off",
    { enabled: false, cut: CUT, record: RECORD },
    { continue: false, reason: "disabled" },
  ],
  [
    "a deleted agent",
    { enabled: true, cut: CUT, record: null },
    { continue: false, reason: "missing" },
  ],
  [
    "an archived agent",
    { enabled: true, cut: CUT, record: { ...RECORD, archivedAt: "2026-10-04T12:01:00.000Z" } },
    { continue: false, reason: "archived" },
  ],
  [
    "a provider switch",
    { enabled: true, cut: CUT, record: { ...RECORD, provider: "codex" } },
    { continue: false, reason: "provider_changed" },
  ],
  [
    "a prompt after the cut",
    {
      enabled: true,
      cut: CUT,
      record: { ...RECORD, lastUserMessageAt: "2026-10-04T12:00:01.000Z" },
    },
    { continue: false, reason: "newer_prompt" },
  ],
  [
    "a Stop before the restart",
    { enabled: true, cut: { ...CUT, stopRequested: true }, record: RECORD },
    { continue: false, reason: "stop_requested" },
  ],
  [
    "an out-of-band command",
    { enabled: true, cut: { ...CUT, outOfBand: true }, record: RECORD },
    { continue: false, reason: "out_of_band" },
  ],
  [
    "no provider session to resume",
    { enabled: true, cut: CUT, record: { ...RECORD, persistence: null } },
    { continue: false, reason: "no_persistence" },
  ],
])("%s decides %j", (_label, input, expected) => {
  expect(decideContinuation(input)).toEqual(expected);
});

test("the background-work note lists ten entries, trims labels, and counts the rest", () => {
  const work = cancelledWorkFromTasks(
    Array.from({ length: 12 }, (_, index) => ({
      id: `task-${index}`,
      taskType: "shell",
      description: index === 0 ? "x".repeat(200) : `npm run   task-${index}`,
      startedAt: "2026-10-04T11:00:00.000Z",
    })),
  );

  const note = restartCancelledWorkNote(work).split("\n");

  expect(note[0]).toBe(
    "Note: the Paseo daemon restarted, and this background work was cancelled before it finished. It will not report back:",
  );
  expect(note.slice(1, 3)).toEqual([`- shell: ${"x".repeat(159)}…`, "- shell: npm run task-1"]);
  expect(note).toHaveLength(12);
  expect(note.at(-1)).toBe("- and 2 more");
  expect(prependRestartNote([{ type: "text", text: "next" }], work.slice(1, 2))).toEqual([
    { type: "text", text: `${note[0]}\n- shell: npm run task-1` },
    { type: "text", text: "next" },
  ]);
});

let host: ControlledHost | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
});

test("a cut run continues once even when its intents are processed twice", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: false });
  await host.agentStorage.flush();
  const intents = new RestartIntentStore(join(host.root, "runtime", "restart-intents.json"));
  const adopted: string[] = [];
  const recovery = new RestartRecovery({
    intents,
    receipts: new MessageReceipts(join(host.root, "agent-requests")),
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    delegations: {
      recoverAfterRestart: async () => undefined,
      adoptContinuedChild: (childAgentId) => adopted.push(childAgentId),
      reportCutChild: async () => undefined,
    },
    continueAfterRestart: () => true,
    logger: host.logger,
  });
  const cut: CutRun = { ...CUT, agentId, cutAt: new Date().toISOString() };

  await intents.write({ version: 1, writtenAt: cut.cutAt, cutRuns: [cut], backgroundWork: {} });
  await (
    await recovery.recoverAfterRestart()
  ).continuations;
  host.session(agentId).completeTurn("picked it back up");
  await host.agentManager.waitForRunToSettle(agentId);
  await host.agentStorage.flush();
  await intents.write({ version: 1, writtenAt: cut.cutAt, cutRuns: [cut], backgroundWork: {} });
  await (
    await recovery.recoverAfterRestart()
  ).continuations;

  expect(host.session(agentId).startPrompts).toEqual(["Continue where you left off."]);
  expect(adopted).toEqual([agentId, agentId]);
});
