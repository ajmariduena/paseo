import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  DelegationStore,
  planDelivery,
  type DelegationFile,
  type DelegationTask,
  type PlanContext,
} from "./delegation-store.js";

const NOW = "2026-10-04T12:00:00.000Z";
const IDLE_PARENT: PlanContext = { isRunLive: () => false, parentArchived: false };
const LIVE_PARENT: PlanContext = { isRunLive: () => true, parentArchived: false };

function terminalTask(id: string, overrides: Partial<DelegationTask> = {}): DelegationTask {
  return {
    id,
    childAgentId: `child-${id}`,
    spawningRunKey: "run-1",
    source: "create_agent",
    title: `Task ${id}`,
    promptPreview: "do it",
    completionWake: "always",
    status: "completed",
    result: `result ${id}`,
    resultTruncated: false,
    completionDelivery: { state: "pending", observedByRunKey: null },
    createdAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fileWith(
  tasks: DelegationTask[],
  cohort: Partial<DelegationFile["cohorts"][string]> = {},
): DelegationFile {
  return {
    version: 1,
    parentAgentId: "parent",
    cohorts: {
      "run-1": { disposition: "open", nextGeneration: 1, delivery: null, ...cohort },
    },
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
  };
}

test("a task already delivered is never planned again", () => {
  const file = fileWith([
    terminalTask("a", { completionDelivery: { state: "delivered", observedByRunKey: null } }),
  ]);

  expect(planDelivery(file, "a", IDLE_PARENT, NOW)).toBeNull();
  expect(file.cohorts["run-1"].delivery).toBeNull();
  expect(file.tasks.a.completionDelivery.state).toBe("delivered");
});

test("a task of a stopped cohort or an archived parent is disposed", () => {
  const stopped = fileWith([terminalTask("a")], { disposition: "stopped" });
  expect(planDelivery(stopped, "a", IDLE_PARENT, NOW)).toBeNull();
  expect(stopped.tasks.a.completionDelivery.state).toBe("disposed");

  const archived = fileWith([terminalTask("a")]);
  expect(planDelivery(archived, "a", { ...IDLE_PARENT, parentArchived: true }, NOW)).toBeNull();
  expect(archived.tasks.a.completionDelivery.state).toBe("disposed");
});

test("a settled-only task waits while its spawning run is live", () => {
  const file = fileWith([terminalTask("a", { completionWake: "settled_only" })]);

  expect(planDelivery(file, "a", LIVE_PARENT, NOW)).toBeNull();
  expect(file.tasks.a.completionDelivery.state).toBe("pending");
  expect(file.cohorts["run-1"].delivery).toBeNull();
});

test("a task joins a queued wake without a second offer", () => {
  const file = fileWith(
    [
      terminalTask("a", { completionDelivery: { state: "claimed", observedByRunKey: null } }),
      terminalTask("b"),
    ],
    {
      nextGeneration: 2,
      delivery: {
        generation: 1,
        messageId: "wake:parent:run-1:1",
        taskIds: ["a"],
        dispatch: { kind: "queued" },
      },
    },
  );

  expect(planDelivery(file, "b", IDLE_PARENT, NOW)).toBeNull();
  expect(file.cohorts["run-1"].delivery?.taskIds).toEqual(["a", "b"]);
  expect(file.tasks.b.completionDelivery.state).toBe("claimed");
});

test("a task finishing while the wake turn runs waits for the successor", () => {
  const file = fileWith([terminalTask("b")], {
    nextGeneration: 2,
    delivery: {
      generation: 1,
      messageId: "wake:parent:run-1:1",
      taskIds: ["a"],
      dispatch: { kind: "started", runKey: "wake-run" },
    },
  });

  expect(planDelivery(file, "b", IDLE_PARENT, NOW)).toBeNull();
  expect(file.cohorts["run-1"].delivery?.taskIds).toEqual(["a"]);
  expect(file.tasks.b.completionDelivery.state).toBe("pending");
});

test("a task joins an undispatched wake and re-offers the same delivery", () => {
  const file = fileWith([terminalTask("b")], {
    nextGeneration: 2,
    delivery: {
      generation: 1,
      messageId: "wake:parent:run-1:1",
      taskIds: ["a"],
      dispatch: { kind: "none" },
    },
  });

  expect(planDelivery(file, "b", IDLE_PARENT, NOW)).toEqual({
    parentAgentId: "parent",
    cohortKey: "run-1",
    generation: 1,
    messageId: "wake:parent:run-1:1",
  });
  expect(file.cohorts["run-1"].delivery?.taskIds).toEqual(["a", "b"]);
});

test("the first terminal task opens a new wake generation with a stable messageId", () => {
  const file = fileWith([terminalTask("a")], { nextGeneration: 3 });

  expect(planDelivery(file, "a", IDLE_PARENT, NOW)).toEqual({
    parentAgentId: "parent",
    cohortKey: "run-1",
    generation: 3,
    messageId: "wake:parent:run-1:3",
  });
  expect(file.cohorts["run-1"]).toEqual({
    disposition: "open",
    nextGeneration: 4,
    delivery: {
      generation: 3,
      messageId: "wake:parent:run-1:3",
      taskIds: ["a"],
      dispatch: { kind: "none" },
    },
  });
  expect(file.tasks.a.completionDelivery.state).toBe("claimed");
});

let directory: string | null = null;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

function createStore(): DelegationStore {
  directory = mkdtempSync(join(tmpdir(), "delegation-store-"));
  return new DelegationStore(directory);
}

async function createFinishedTask(store: DelegationStore, id: string): Promise<void> {
  await store.createTask(
    "parent",
    {
      id,
      childAgentId: `child-${id}`,
      spawningRunKey: "run-1",
      source: "create_agent",
      title: `Task ${id}`,
      prompt: "do it",
      completionWake: "always",
    },
    NOW,
  );
  await store.finalizeTask(
    "parent",
    id,
    { status: "completed", result: `result ${id}`, wake: true },
    LIVE_PARENT,
    NOW,
  );
}

test("each store method commits the whole parent file atomically", async () => {
  const store = createStore();
  await createFinishedTask(store, "a");

  const onDisk = JSON.parse(readFileSync(join(directory!, "parent.json"), "utf8"));
  expect(onDisk).toEqual(await store.get("parent"));
  expect(onDisk.cohorts["run-1"].delivery).toEqual({
    generation: 1,
    messageId: "wake:parent:run-1:1",
    taskIds: ["a"],
    dispatch: { kind: "none" },
  });
  expect(JSON.parse(readFileSync(join(directory!, "by-child.json"), "utf8"))).toEqual({
    "child-a": ["parent"],
  });
});

test("acknowledging clears a wake that has not started, and repeats are no-ops", async () => {
  const store = createStore();
  await createFinishedTask(store, "a");

  const first = await store.acknowledgeChildResults("parent", "child-a", "run-2", NOW);
  const second = await store.acknowledgeChildResults("parent", "child-a", "run-3", NOW);

  expect(first).toMatchObject({ id: "a", status: "completed", result: "result a" });
  expect(second).toEqual(first);
  const file = await store.get("parent");
  expect(file?.cohorts["run-1"].delivery).toBeNull();
  expect(file?.tasks.a.completionDelivery).toEqual({
    state: "acknowledged",
    observedByRunKey: "run-2",
  });
});

test("disposal is final and repeatable", async () => {
  const store = createStore();
  await createFinishedTask(store, "a");

  await store.stopAll("parent", NOW);
  await store.disposeAll("parent", NOW);
  await store.disposeAll("parent", NOW);

  const file = await store.get("parent");
  expect(file?.cohorts["run-1"]).toEqual({
    disposition: "disposed",
    nextGeneration: 2,
    delivery: null,
  });
  expect(file?.tasks.a.completionDelivery.state).toBe("disposed");
});

test("a result held by a wait is offered when the wait releases it, never twice", async () => {
  const store = createStore();
  await store.createTask(
    "parent",
    {
      id: "a",
      childAgentId: "child-a",
      spawningRunKey: "run-1",
      source: "create_agent",
      title: "Task a",
      prompt: "do it",
      completionWake: "always",
    },
    NOW,
  );
  const waitingOnRun2: PlanContext = {
    isRunLive: (runKey) => runKey === "run-2",
    parentArchived: false,
  };
  await store.setWakePolicy(
    "parent",
    "child-a",
    { completionWake: "settled_only", waitRunKey: "run-2" },
    waitingOnRun2,
    NOW,
  );
  const held = await store.finalizeTask(
    "parent",
    "a",
    { status: "completed", result: "result a", wake: true },
    waitingOnRun2,
    NOW,
  );
  expect(held).toBeNull();

  const released = await store.setWakePolicy(
    "parent",
    "child-a",
    { completionWake: "always", waitRunKey: null },
    waitingOnRun2,
    NOW,
  );
  expect(released).toMatchObject({ cohortKey: "run-1", generation: 1 });
  const again = await store.setWakePolicy(
    "parent",
    "child-a",
    { completionWake: "always", waitRunKey: null },
    waitingOnRun2,
    NOW,
  );
  expect(again).toBeNull();
});
