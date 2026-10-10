import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";

import {
  createControlledHost,
  createTraceRecorder,
  SteerableControlledAgentSession,
  ControlledAgentSession,
  type ControlledHost,
  type TraceRecorder,
} from "../test-utils/controlled-agent-client.js";
import { DelegationService } from "./delegation-service.js";
import { DelegationStore } from "./delegation-store.js";
import { readRetainedHandoffHistory, writeHandoffHistory } from "../handoff/history.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";

interface DelegationScenario {
  host: ControlledHost;
  trace: TraceRecorder;
  store: DelegationStore;
  service: DelegationService;
  parentId: string;
  childIds: string[];
}

let scenario: DelegationScenario | null = null;

afterEach(async () => {
  scenario?.service.close();
  await scenario?.host.cleanup();
  scenario = null;
});

async function startDelegation(options: {
  parentSteerable: boolean;
  children: number;
}): Promise<DelegationScenario> {
  const host = createControlledHost({
    beforeRetainedContinuation: (agentId) => scenario!.service.checkpointRetainedResults(agentId),
  });
  const trace = createTraceRecorder();
  const store = new DelegationStore(join(host.root, "delegations"));
  const service = new DelegationService({
    store,
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    logger: trace.logger,
    readRetainedHistory: (agentId, blob) => readRetainedHandoffHistory(host.root, agentId, blob),
  });
  const parentId = await host.createAgent({ steerable: options.parentSteerable });
  await host.startTurn(parentId, "parent work");
  const childIds: string[] = [];
  for (const label of ["A", "B", "C"].slice(0, options.children)) {
    const childId = await host.createAgent({
      steerable: false,
      labels: { "paseo.parent-agent-id": parentId },
    });
    await host.startTurn(childId, `task ${label}`);
    await service.delegate({
      parentAgentId: parentId,
      childAgentId: childId,
      source: "create_agent",
      title: `Task ${label}`,
      prompt: `task ${label}`,
      requireParentOwnership: true,
    });
    childIds.push(childId);
  }
  scenario = { host, trace, store, service, parentId, childIds };
  return scenario;
}

async function deliveryStates(current: DelegationScenario): Promise<string[]> {
  const file = await current.store.get(current.parentId);
  return Object.values(file?.tasks ?? {}).map((task) => task.completionDelivery.state);
}

function wakeMessageIds(current: DelegationScenario): string[] {
  return current.host.agentManager
    .getTimeline(current.parentId)
    .flatMap((item) =>
      item.type === "notification" && item.messageId?.startsWith("wake:") ? [item.messageId] : [],
    );
}

test("two children finishing while the parent runs produce one wake with both results", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 2 });
  const { host, trace, parentId, childIds } = current;
  const parent = host.session(parentId);

  host.session(childIds[0]).completeTurn("result A");
  host.session(childIds[1]).completeTurn("result B");
  await trace.waitFor("delegation.finalized", 2);
  await trace.waitFor("agent.dispatch.wait_for_turn");
  expect(parent.startPrompts).toEqual(["parent work"]);
  expect(parent.interruptCount).toBe(0);

  parent.completeTurn("parent done");
  await vi.waitFor(() => expect(parent.startPrompts).toHaveLength(2));
  expect(parent.startPrompts[1]).toMatch(
    /2 delegated tasks reported back: (Task A, Task B|Task B, Task A)\n/,
  );
  expect(parent.startPrompts[1]).toContain("result A");
  expect(parent.startPrompts[1]).toContain("result B");
  const timeline = host.agentManager.getTimeline(parentId);
  expect(timeline.filter((item) => item.type === "user_message")).toEqual([]);
  const wakeRows = timeline.filter((item) => item.type === "notification");
  expect(wakeRows).toEqual([
    {
      type: "notification",
      level: "info",
      message: expect.stringMatching(/^2 delegated tasks reported back: Task [AB], Task [AB]$/),
      messageId: expect.stringMatching(/^wake:.+:1$/),
      source: {
        kind: "subagent",
        subagents: expect.arrayContaining(
          ["A", "B"].map((label, index) => ({
            agentId: childIds[index],
            reason: "finished",
            title: `Task ${label}`,
            durationMs: expect.any(Number),
          })),
        ),
      },
    },
  ]);

  parent.completeTurn("read both");
  await vi.waitFor(async () =>
    expect(await deliveryStates(current)).toEqual(["delivered", "delivered"]),
  );
  expect(parent.startPrompts).toHaveLength(2);
  expect(parent.interruptCount).toBe(0);
});

async function retainChild(current: DelegationScenario) {
  const { host, service, childIds } = current;
  const childId = childIds[0];
  const descendantId = await host.createAgent({
    steerable: false,
    labels: { "paseo.parent-agent-id": childId },
  });
  await host.startTurn(descendantId, "Independent work continues");
  await service.delegate({
    parentAgentId: childId,
    childAgentId: descendantId,
    source: "create_agent",
    title: "Independent descendant",
    prompt: "Independent work continues",
    requireParentOwnership: true,
  });
  host.session(childId).completeTurn("Original result before handoff");
  await vi.waitFor(() => expect(host.agentManager.getAgent(childId)?.lifecycle).toBe("idle"));
  await host.startTurn(childId, "Still working when handoff stops me");
  const rows = await host.agentManager.getTimelineRows(childId);
  const transferId = randomUUID();
  await host.agentStorage.retainForHandoff(childId, transferId);
  await host.agentManager.messageQueue.hold(childId, "user_stop");
  await host.agentManager.closeAgent(childId);
  await mkdir(join(host.root, "retained"), { recursive: true });
  const temporary = join(host.root, "retained", "pending.json");
  await writeHandoffHistory(temporary, {
    version: 1,
    sourceAgentId: childId,
    epoch: transferId,
    rows,
  });
  const bytes = await readFile(temporary);
  const blob = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  await rename(temporary, join(host.root, "retained", `${blob.sha256}.json`));
  await host.agentStorage.checkpointRetainedHistory(childId, blob);
  expect(host.agentManager.getAgent(childId)).toBeNull();
  expect(host.agentManager.getAgent(descendantId)?.lifecycle).toBe("running");
  return { childId, descendantId, blob };
}

async function continueRetainedChild(
  current: DelegationScenario,
  childId: string,
): Promise<string> {
  const { host, service } = current;
  await sendPromptToAgent({
    agentId: childId,
    prompt: "A new human request",
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    logger: host.logger,
  });
  await host.agentManager.waitForAgentRunStart(childId);
  const session = host.agentManager.getAgent(childId)!.session as ControlledAgentSession;
  session.completeTurn("New response must not replace the stopped result");
  await vi.waitFor(() => expect(host.agentManager.getAgent(childId)?.lifecycle).toBe("idle"));
  await host.startTurn(childId, "More unrelated work");
  const newChildId = await host.createAgent({
    steerable: false,
    labels: { "paseo.parent-agent-id": childId },
  });
  await host.startTurn(newChildId, "New descendant must not delay the stopped result");
  await service.delegate({
    parentAgentId: childId,
    childAgentId: newChildId,
    source: "create_agent",
    title: "New descendant",
    prompt: "Unrelated work",
    requireParentOwnership: true,
  });
  return newChildId;
}

async function recoverDelegationService(
  current: DelegationScenario,
  childId: string,
  descendantId: string,
) {
  current.service.close();
  const { host, trace } = current;
  current.store = new DelegationStore(join(host.root, "delegations"));
  current.service = new DelegationService({
    store: current.store,
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    logger: trace.logger,
    readRetainedHistory: (agentId, blob) => readRetainedHandoffHistory(host.root, agentId, blob),
  });
  await current.service.recoverAfterRestart({
    cut: new Set([childId]),
    continuing: new Set([descendantId]),
  });
  current.service.adoptContinuedChild(descendantId);
}

test
  .skipIf(process.platform === "win32")
  .each(["held", "continued", "recovered before checkpoint", "recovered after continuation"])(
  "a retained child preserves its stopped result with a late descendant: %s",
  async (mode) => {
    const current = await startDelegation({ parentSteerable: false, children: 1 });
    const { host, parentId } = current;
    const { childId, descendantId } = await retainChild(current);
    if (mode === "recovered before checkpoint")
      await recoverDelegationService(current, childId, descendantId);
    const continued = mode === "continued" || mode === "recovered after continuation";
    const newChildId = continued ? await continueRetainedChild(current, childId) : undefined;
    await current.service.checkpointRetainedResults(childId);
    await vi.waitFor(async () =>
      expect(Object.values((await current.store.get(parentId))!.tasks)).toMatchObject([
        {
          status: "running",
          handoffSettlement: {
            status: "cancelled",
            result: "Original result before handoff",
            pendingChildTaskIds: [expect.any(String)],
          },
        },
      ]),
    );
    if (mode === "recovered after continuation")
      await recoverDelegationService(current, childId, descendantId);
    host.session(descendantId).completeTurn("Late descendant result");
    await vi.waitFor(async () =>
      expect(Object.values((await current.store.get(parentId))!.tasks)).toMatchObject([
        { status: "cancelled", result: "Original result before handoff" },
      ]),
    );
    if (newChildId) {
      expect(host.agentManager.getAgent(childId)?.lifecycle).toBe("running");
      expect(host.agentManager.getAgent(newChildId)?.lifecycle).toBe("running");
    } else {
      expect(host.agentManager.getAgent(childId)).toBeNull();
      expect(host.agentManager.messageQueue.isHeldForUserStop(childId)).toBe(true);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "damaged retained history blocks explicit continuation until the original checkpoint is restored",
  async () => {
    const current = await startDelegation({ parentSteerable: false, children: 1 });
    const { host } = current;
    // Stop automatic checks so the explicit-continuation hook owns this publication attempt.
    current.service.close();
    const { childId, blob } = await retainChild(current);
    const file = join(host.root, "retained", `${blob.sha256}.json`);
    const original = await readFile(file);
    await writeFile(file, "damaged");
    const prompt = {
      agentId: childId,
      prompt: "Resume after handoff",
      agentManager: host.agentManager,
      agentStorage: host.agentStorage,
      logger: host.logger,
    };
    await expect(sendPromptToAgent(prompt)).rejects.toThrow(
      "Retained conversation history is damaged",
    );
    expect(host.agentManager.getAgent(childId)).toBeNull();
    expect((await host.agentStorage.get(childId))?.handoffRetention?.delegationsPending).toBe(true);
    expect(host.agentManager.messageQueue.isHeldForUserStop(childId)).toBe(true);
    await writeFile(file, original);
    await expect(sendPromptToAgent(prompt)).resolves.toMatchObject({ disposition: "started" });
  },
);

test("a delegated wake owns the parent's finished attention", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, parentId, childIds } = current;
  const attention: string[] = [];
  host.agentManager.setAgentAttentionCallback(({ agentId }) => attention.push(agentId));

  host.session(parentId).completeTurn("delegated");
  await vi.waitFor(() => expect(host.agentManager.getAgent(parentId)?.lifecycle).toBe("idle"));
  expect(attention).toEqual([]);

  host.session(childIds[0]).completeTurn("result");
  await vi.waitFor(() => expect(host.session(parentId).startPrompts).toHaveLength(2));
  expect(attention).toEqual([]);

  host.session(parentId).completeTurn("reviewed result");
  await vi.waitFor(() => expect(attention).toEqual([parentId]));
});

test("detaching a running child releases the parent's finished attention", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, parentId, childIds } = current;
  const attention: string[] = [];
  host.agentManager.setAgentAttentionCallback(({ agentId }) => attention.push(agentId));
  host.session(parentId).completeTurn("delegated");
  await vi.waitFor(() => expect(host.agentManager.getAgent(parentId)?.lifecycle).toBe("idle"));
  expect(attention).toEqual([]);

  await host.agentManager.detachAgent(childIds[0]);
  await vi.waitFor(() => expect(attention).toEqual([parentId]));
});

test("a third child finishing during the wake turn goes out in exactly one successor", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 3 });
  const { host, trace, parentId, childIds } = current;
  const parent = host.session(parentId);

  host.session(childIds[0]).completeTurn("result A");
  host.session(childIds[1]).completeTurn("result B");
  await trace.waitFor("delegation.finalized", 2);
  parent.completeTurn("parent done");
  await vi.waitFor(() => expect(parent.startPrompts).toHaveLength(2));
  expect(parent.startPrompts[1]).toContain("2 of 3 delegated tasks reported back");

  host.session(childIds[2]).completeTurn("result C");
  await trace.waitFor("delegation.finalized", 3);
  expect(parent.startPrompts).toHaveLength(2);

  parent.completeTurn("read A and B");
  await vi.waitFor(() => expect(parent.startPrompts).toHaveLength(3));
  expect(parent.startPrompts[2]).toContain("Task C");
  expect(parent.startPrompts[2]).toContain("result C");
  expect(parent.startPrompts[2]).not.toContain("result A");

  parent.completeTurn("read C");
  await vi.waitFor(async () =>
    expect(await deliveryStates(current)).toEqual(["delivered", "delivered", "delivered"]),
  );
  expect(parent.startPrompts).toHaveLength(3);
  const [first, second] = wakeMessageIds(current);
  expect(first).toMatch(/^wake:.+:1$/);
  expect(second).toBe(first.replace(/:1$/, ":2"));
});

test("steer accepted marks tasks delivered", async () => {
  const current = await startDelegation({ parentSteerable: true, children: 1 });
  const { host, parentId, childIds } = current;
  const parent = host.session(parentId);

  host.session(childIds[0]).completeTurn("result A");

  await vi.waitFor(async () => expect(await deliveryStates(current)).toEqual(["delivered"]));
  expect(parent.steerPrompts).toHaveLength(1);
  expect(parent.steerPrompts[0]).toContain("result A");
  expect(parent.startPrompts).toEqual(["parent work"]);
  expect(parent.interruptCount).toBe(0);
});

test("late steer becomes a queued wake with the same messageId", async () => {
  const current = await startDelegation({ parentSteerable: true, children: 1 });
  const { host, parentId, childIds } = current;
  const parent = host.session(parentId);
  if (!(parent instanceof SteerableControlledAgentSession)) throw new Error("not steerable");
  parent.steerOutcome = "late";

  host.session(childIds[0]).completeTurn("result A");

  await vi.waitFor(() => expect(parent.startPrompts).toHaveLength(2));
  expect(parent.startPrompts[1]).toContain("result A");
  expect(parent.interruptCount).toBe(0);
  expect(wakeMessageIds(current)).toEqual([expect.stringMatching(/^wake:.+:1$/)]);
});

test("an idle-path wake does not replace a run that started in between", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, parentId, childIds } = current;
  const parent = host.session(parentId);
  parent.completeTurn("parent done");
  await host.agentManager.waitForRunToSettle(parentId);

  let userRun: Promise<void> | null = null;
  parent.beforeDispatch = (prompt) => {
    if (userRun || typeof prompt !== "string" || !prompt.includes("Delegated task")) return;
    const events = host.agentManager.streamAgent(parentId, "user work");
    userRun = (async () => {
      for await (const _event of events) {
        // Drain the user's turn.
      }
    })();
  };

  host.session(childIds[0]).completeTurn("result A");
  await vi.waitFor(() => expect(parent.startPrompts).toEqual(["parent work", "user work"]));
  expect(parent.interruptCount).toBe(0);

  parent.completeTurn("user done");
  await vi.waitFor(() => expect(parent.startPrompts).toHaveLength(3));
  expect(parent.startPrompts[2]).toContain("result A");
  expect(parent.interruptCount).toBe(0);
  await userRun;
});

test("a child holding background tasks does not finalize", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, trace, store, parentId, childIds } = current;
  const child = host.session(childIds[0]);

  child.setBackgroundTasks([
    { id: "bg-1", taskType: "shell", description: "npm run dev", startedAt: "2026-10-04" },
  ]);
  child.completeTurn("result A");
  await trace.waitFor("delegation.child_still_working");
  const waiting = await store.get(parentId);
  expect(Object.values(waiting?.tasks ?? {}).map((task) => task.status)).toEqual(["running"]);

  child.setBackgroundTasks([]);
  await trace.waitFor("delegation.finalized");
  const finished = await store.get(parentId);
  expect(Object.values(finished?.tasks ?? {})).toEqual([
    expect.objectContaining({ status: "completed", result: "result A" }),
  ]);
});

test("parent archive disposes pending wakes", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, trace, store, service, parentId, childIds } = current;
  host.agentManager.setAgentArchivedCallback((agentId) => service.disposeForArchivedAgent(agentId));

  host.session(childIds[0]).completeTurn("result A");
  await trace.waitFor("agent.dispatch.wait_for_turn");
  await host.agentManager.archiveAgent(parentId);
  await trace.waitFor("delegation.wake.dispatched");

  const file = await store.get(parentId);
  expect(Object.values(file?.cohorts ?? {})).toEqual([
    { disposition: "disposed", nextGeneration: 2, delivery: null },
  ]);
  expect(await deliveryStates(current)).toEqual(["disposed"]);
  expect(host.session(parentId).startPrompts).toEqual(["parent work"]);
});

test("host cleanup waits for registration writes before removing its directory", async () => {
  const host = createControlledHost();
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let writeSettled = false;
  const applySnapshot = host.agentStorage.applySnapshot.bind(host.agentStorage);
  // Hold a real registration write across teardown, as a queued wake can do.
  const delayed = vi
    .spyOn(host.agentStorage, "applySnapshot")
    .mockImplementationOnce(async (value) => {
      enter();
      await gate;
      try {
        await applySnapshot(value);
      } finally {
        writeSettled = true;
      }
    });
  const creating = host.createAgent({ steerable: false }).catch((error: unknown) => error);
  try {
    await entered;
    const cleaned = host.cleanup().then(() => ({ writeSettled, exists: existsSync(host.root) }));
    release();
    const [, atCleanup] = await Promise.all([creating, cleaned]);
    expect(atCleanup).toEqual({ writeSettled: true, exists: false });
    expect(existsSync(host.root)).toBe(false);
  } finally {
    release();
    await creating;
    delayed.mockRestore();
    await host.cleanup();
  }
});

test("user Stop of the spawning turn stops its cohort", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, trace, store, service, parentId, childIds } = current;

  await service.stopAll(parentId);
  await host.agentManager.cancelAgentRun(parentId);
  host.session(childIds[0]).completeTurn("result A");
  await trace.waitFor("delegation.finalized");

  const file = await store.get(parentId);
  expect(Object.values(file?.cohorts ?? {})).toEqual([
    { disposition: "stopped", nextGeneration: 1, delivery: null },
  ]);
  expect(await deliveryStates(current)).toEqual(["disposed"]);
  expect(host.session(parentId).startPrompts).toEqual(["parent work"]);
});

test("user Stop of an idle parent stops the cohorts of its earlier runs", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 2 });
  const { host, trace, store, service, parentId, childIds } = current;
  const parent = host.session(parentId);
  parent.completeTurn("waiting on children");
  await vi.waitFor(() => expect(host.agentManager.getAgent(parentId)?.lifecycle).toBe("idle"));

  await service.stopAll(parentId);
  host.session(childIds[0]).completeTurn("result A");
  host.session(childIds[1]).completeTurn("result B");
  await trace.waitFor("delegation.finalized", 2);

  const file = await store.get(parentId);
  expect(Object.values(file?.cohorts ?? {})).toEqual([
    { disposition: "stopped", nextGeneration: 1, delivery: null },
  ]);
  expect(await deliveryStates(current)).toEqual(["disposed", "disposed"]);
  expect(parent.startPrompts).toEqual(["parent work"]);
});

test("user Stop withdraws a wake already waiting in the parent's queue", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, trace, service, parentId, childIds } = current;
  host.session(childIds[0]).completeTurn("result A");
  await trace.waitFor("agent.dispatch.wait_for_turn");
  expect(host.agentManager.messageQueue.entries(parentId)).toHaveLength(1);

  await service.stopAll(parentId);

  expect(host.agentManager.messageQueue.entries(parentId)).toEqual([]);
  expect(await deliveryStates(current)).toEqual(["disposed"]);
});

test("reading a finished result cancels the still-queued wake", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, trace, service, parentId, childIds } = current;
  const parent = host.session(parentId);

  host.session(childIds[0]).completeTurn("result A");
  await trace.waitFor("agent.dispatch.wait_for_turn");
  const task = await service.acknowledgeChildResults({
    parentAgentId: parentId,
    childAgentId: childIds[0],
  });
  expect(task).toMatchObject({ status: "completed", result: "result A" });

  parent.completeTurn("parent done");
  await trace.waitFor("delegation.wake.dispatched");
  expect(parent.startPrompts).toEqual(["parent work"]);
  expect(await deliveryStates(current)).toEqual(["acknowledged"]);
});

test("reading a running child acknowledges nothing", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { service, parentId, childIds } = current;

  const task = await service.acknowledgeChildResults({
    parentAgentId: parentId,
    childAgentId: childIds[0],
  });

  expect(task).toBeNull();
  expect(await deliveryStates(current)).toEqual(["pending"]);
});
