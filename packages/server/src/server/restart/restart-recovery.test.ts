import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { MessageReceipts } from "../message-receipts/index.js";
import {
  createControlledHost,
  type ControlledHost,
} from "../test-utils/controlled-agent-client.js";

import { AgentStorage, type StoredAgentRecord } from "../agent/agent-storage.js";
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
  type RestartRecoveryOptions,
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

test("handoff watch notes identify stopped source watches without claiming a daemon restart", () => {
  expect(
    restartCancelledWorkNote([
      {
        id: "transfer:watch",
        kind: "handoff_pull_request_watch",
        label: "PR #42. Restart explicitly if needed.",
      },
    ]),
  ).toBe(
    "Note: these PR watches were stopped for the workspace handoff. They have not been restarted:\n- PR #42. Restart explicitly if needed.",
  );
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
  vi.restoreAllMocks();
  await host?.cleanup();
  host = null;
});

test.each([false, true])(
  "a failed restart-note write retains recovery input (continuation declined: %s)",
  async (enabled) => {
    host = createControlledHost();
    const agentId = await host.createAgent({ steerable: false });
    await host.agentStorage.flush();
    const intentPath = join(host.root, "runtime", "restart-intents.json");
    const intents = new RestartIntentStore(intentPath);
    const cut: CutRun = { ...CUT, agentId, cutAt: new Date().toISOString() };
    const lostWork = [{ kind: "shell", label: "npm run dev", id: "lost-task" }];
    const file = {
      version: 1 as const,
      writtenAt: cut.cutAt,
      cutRuns: [cut],
      backgroundWork: { [agentId]: lostWork },
    };
    await intents.write(file);
    const options: RestartRecoveryOptions = {
      intents,
      receipts: {
        send: async () => {
          throw new Error("provider unavailable");
        },
      },
      agentManager: host.agentManager,
      agentStorage: host.agentStorage,
      delegations: {
        recoverAfterRestart: async () => undefined,
        adoptContinuedChild: () => undefined,
        reportCutChild: async () => undefined,
      },
      continueAfterRestart: () => enabled,
      logger: host.logger,
    };
    vi.spyOn(host.agentStorage, "addPendingRestartNote").mockRejectedValueOnce(
      new Error("note write failed"),
    );

    const recovery = new RestartRecovery(options);
    await expect(
      recovery.recoverAfterRestart().then((result) => result.continuations),
    ).rejects.toThrow("note write failed");
    expect(await new RestartIntentStore(intentPath).read()).toEqual(file);
    expect(host.session(agentId).startPrompts).toEqual([]);

    await recovery.prepareForShutdown();
    expect((await intents.read())?.backgroundWork).toEqual({ [agentId]: lostWork });
    const retried = new RestartRecovery({
      ...options,
      intents: new RestartIntentStore(intentPath),
      agentStorage: new AgentStorage(join(host.root, "agents"), host.logger),
    });
    await (
      await retried.recoverAfterRestart()
    ).continuations;
    expect(await intents.read()).toBeNull();
    const disk = new AgentStorage(join(host.root, "agents"), host.logger);
    expect((await disk.get(agentId))?.pendingRestartNote).toEqual(lostWork);
    expect(host.session(agentId).startPrompts).toEqual([]);
  },
);

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

test("a stopped continuation keeps its lost-work note without reopening the provider or queueing a prompt", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: false });
  await host.agentManager.closeAgent(agentId);
  await host.agentManager.messageQueue.hold(agentId, "user_stop");
  const intents = new RestartIntentStore(join(host.root, "runtime", "restart-intents.json"));
  const cut: CutRun = { ...CUT, agentId, cutAt: new Date().toISOString() };
  const work = [{ kind: "shell", label: "npm run dev", id: "lost-task" }];
  await intents.write({
    version: 1,
    writtenAt: cut.cutAt,
    cutRuns: [cut],
    backgroundWork: { [agentId]: work },
  });
  const prepared = Promise.withResolvers<void>();
  const receipts = new MessageReceipts(join(host.root, "agent-requests"));
  const recovery = new RestartRecovery({
    intents,
    receipts: {
      send: (input) =>
        receipts.send({
          ...input,
          prepare: async () => {
            await input.prepare?.();
            prepared.resolve();
          },
        }),
    },
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    delegations: {
      recoverAfterRestart: async () => undefined,
      adoptContinuedChild: () => undefined,
      reportCutChild: async () => undefined,
    },
    continueAfterRestart: () => true,
    logger: host.logger,
  });
  const { continuations } = await recovery.recoverAfterRestart();
  try {
    await prepared.promise;
    expect(host.agentManager.getAgent(agentId)).toBeNull();
    await continuations;
    expect(host.agentManager.messageQueue.entries(agentId)).toEqual([]);
    expect(host.agentManager.messageQueue.isHeldForUserStop(agentId)).toBe(true);
    expect((await host.agentStorage.get(agentId))?.pendingRestartNote).toEqual(work);
    expect(await intents.read()).toBeNull();
  } finally {
    await host.agentManager.messageQueue.clear(agentId);
    await continuations;
  }
});

test("a Stop arriving during continuation dispatch drops the automatic prompt", async () => {
  const controlled = createControlledHost();
  host = controlled;
  const agentId = await controlled.createAgent({ steerable: false });
  await controlled.agentStorage.flush();
  const intents = new RestartIntentStore(join(controlled.root, "runtime", "restart-intents.json"));
  const cut: CutRun = { ...CUT, agentId, cutAt: new Date().toISOString() };
  const work = [{ kind: "shell", label: "npm run dev", id: "lost-task" }];
  await intents.write({
    version: 1,
    writtenAt: cut.cutAt,
    cutRuns: [cut],
    backgroundWork: { [agentId]: work },
  });
  const queue = controlled.agentManager.messageQueue;
  const queued = Promise.withResolvers<"queued">();
  const enqueue = queue.enqueue.bind(queue);
  vi.spyOn(queue, "enqueue").mockImplementation(async (...args) => {
    const result = await enqueue(...args);
    queued.resolve("queued");
    return result;
  });
  const receipts = new MessageReceipts(join(controlled.root, "agent-requests"));
  const get = controlled.agentStorage.get.bind(controlled.agentStorage);
  const recovery = new RestartRecovery({
    intents,
    receipts: {
      send: (input) =>
        receipts.send({
          ...input,
          send: async () => {
            // Stop while dispatch reads the archive state, after the receipt's admission check.
            vi.spyOn(controlled.agentStorage, "get").mockImplementationOnce(async (id) => {
              const record = await get(id);
              await queue.hold(agentId, "user_stop");
              return record;
            });
            await input.send();
          },
        }),
    },
    agentManager: controlled.agentManager,
    agentStorage: controlled.agentStorage,
    delegations: {
      recoverAfterRestart: async () => undefined,
      adoptContinuedChild: () => undefined,
      reportCutChild: async () => undefined,
    },
    continueAfterRestart: () => true,
    logger: controlled.logger,
  });
  const { continuations } = await recovery.recoverAfterRestart();
  try {
    await expect(
      Promise.race([continuations.then(() => "finished"), queued.promise]),
    ).resolves.toBe("finished");
    expect(controlled.session(agentId).startPrompts).toEqual([]);
    expect(queue.entries(agentId)).toEqual([]);
    expect(queue.isHeldForUserStop(agentId)).toBe(true);
    expect((await controlled.agentStorage.get(agentId))?.pendingRestartNote).toEqual(work);
    expect(await intents.read()).toBeNull();
  } finally {
    await queue.clear(agentId);
    await continuations;
  }
});

test("a pending continuation keeps its intent and cannot consume a newer shutdown", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: false });
  await host.agentStorage.flush();
  const intentPath = join(host.root, "runtime", "restart-intents.json");
  const intents = new RestartIntentStore(intentPath);
  const receipts = new MessageReceipts(join(host.root, "agent-requests"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cut: CutRun = { ...CUT, agentId, cutAt: new Date().toISOString() };
  const oldWork = { kind: "shell", label: "npm run dev", id: "old-task" };
  const nextWork = { kind: "shell", label: "npm run build", id: "next-task" };
  const file = {
    version: 1 as const,
    writtenAt: cut.cutAt,
    cutRuns: [cut],
    backgroundWork: { [agentId]: [oldWork] },
  };
  await intents.write(file);
  const recovery = new RestartRecovery({
    intents,
    receipts: {
      send: async (input) => {
        entered.resolve();
        await release.promise;
        await receipts.send(input);
      },
    },
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    delegations: {
      recoverAfterRestart: async () => undefined,
      adoptContinuedChild: () => undefined,
      reportCutChild: async () => undefined,
    },
    continueAfterRestart: () => true,
    logger: host.logger,
  });

  const { continuations } = await recovery.recoverAfterRestart();
  try {
    await entered.promise;
    expect(await new RestartIntentStore(intentPath).read()).toEqual(file);
    await intents.write({
      ...file,
      cutRuns: [],
      backgroundWork: { [agentId]: [nextWork, oldWork] },
    });
  } finally {
    release.resolve();
    await continuations;
  }

  expect(await new RestartIntentStore(intentPath).read()).toEqual({
    ...file,
    cutRuns: [],
    backgroundWork: { [agentId]: [oldWork, nextWork] },
  });
  expect(host.session(agentId).startPrompts).toEqual([
    `${restartCancelledWorkNote([oldWork])}\n\nContinue where you left off.`,
  ]);
});

test("a completed dispatch receipt does not erase a failed fallback note on retry", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: false });
  await host.startTurn(agentId, "a turn already running at recovery");
  await host.agentStorage.flush();
  const intentPath = join(host.root, "runtime", "restart-intents.json");
  const intents = new RestartIntentStore(intentPath);
  const cut: CutRun = { ...CUT, agentId, cutAt: new Date().toISOString() };
  const lostWork = [{ kind: "shell", label: "npm run dev", id: "lost-task" }];
  await intents.write({
    version: 1,
    writtenAt: cut.cutAt,
    cutRuns: [cut],
    backgroundWork: { [agentId]: lostWork },
  });
  const options: RestartRecoveryOptions = {
    intents,
    receipts: new MessageReceipts(join(host.root, "agent-requests")),
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    delegations: {
      recoverAfterRestart: async () => undefined,
      adoptContinuedChild: () => undefined,
      reportCutChild: async () => undefined,
    },
    continueAfterRestart: () => true,
    logger: host.logger,
  };
  vi.spyOn(host.agentStorage, "addPendingRestartNote").mockRejectedValueOnce(
    new Error("fallback note failed"),
  );

  await expect(
    new RestartRecovery(options).recoverAfterRestart().then((result) => result.continuations),
  ).rejects.toThrow("fallback note failed");
  host.session(agentId).completeTurn("done");
  await host.agentManager.waitForRunToSettle(agentId);
  await host.agentStorage.flush();
  const retry = new RestartRecovery({
    ...options,
    intents: new RestartIntentStore(intentPath),
    receipts: new MessageReceipts(join(host.root, "agent-requests")),
  });
  await (
    await retry.recoverAfterRestart()
  ).continuations;

  const disk = new AgentStorage(join(host.root, "agents"), host.logger);
  expect((await disk.get(agentId))?.pendingRestartNote).toEqual(lostWork);
  expect(await intents.read()).toBeNull();
  expect(host.session(agentId).startPrompts).toEqual(["a turn already running at recovery"]);
});
