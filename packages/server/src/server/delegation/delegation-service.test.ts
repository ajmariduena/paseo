import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import {
  createControlledHost,
  createTraceRecorder,
  SteerableControlledAgentSession,
  type ControlledHost,
  type TraceRecorder,
} from "../test-utils/controlled-agent-client.js";
import { DelegationService } from "./delegation-service.js";
import { DelegationStore } from "./delegation-store.js";

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
  const host = createControlledHost();
  const trace = createTraceRecorder();
  const store = new DelegationStore(join(host.root, "delegations"));
  const service = new DelegationService({
    store,
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    logger: trace.logger,
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
      item.type === "user_message" && item.messageId?.startsWith("wake:") ? [item.messageId] : [],
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

  parent.completeTurn("read both");
  await vi.waitFor(async () =>
    expect(await deliveryStates(current)).toEqual(["delivered", "delivered"]),
  );
  expect(parent.startPrompts).toHaveLength(2);
  expect(parent.interruptCount).toBe(0);
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

test("user Stop of the spawning turn stops its cohort", async () => {
  const current = await startDelegation({ parentSteerable: false, children: 1 });
  const { host, trace, store, service, parentId, childIds } = current;

  await service.stopActiveTurn(parentId);
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
