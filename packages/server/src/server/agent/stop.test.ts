import { join } from "node:path";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, expect, test } from "vitest";

import { DelegationService } from "../delegation/delegation-service.js";
import { DelegationStore } from "../delegation/delegation-store.js";
import {
  createControlledHost,
  createTraceRecorder,
  type ControlledHost,
  type TraceRecorder,
} from "../test-utils/controlled-agent-client.js";
import { AgentRunStoppedError, AgentStop } from "./stop.js";

interface StopScenario {
  host: ControlledHost;
  trace: TraceRecorder;
  delegations: DelegationService;
  disposedWatches: string[];
  agentStop: AgentStop;
}

let scenario: StopScenario | null = null;

afterEach(async () => {
  scenario?.delegations.close();
  await scenario?.host.cleanup();
  scenario = null;
});

function createScenario(): StopScenario {
  const host = createControlledHost();
  const trace = createTraceRecorder();
  const delegations = new DelegationService({
    store: new DelegationStore(join(host.root, "delegations")),
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    logger: trace.logger,
  });
  const disposedWatches: string[] = [];
  const agentStop = new AgentStop({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    delegations,
    pullRequestWatches: {
      async disposeForAgent(agentId) {
        disposedWatches.push(agentId);
      },
    },
    logger: trace.logger,
  });
  scenario = { host, trace, delegations, disposedWatches, agentStop };
  return scenario;
}

async function createRunningChild(current: StopScenario, parentId: string): Promise<string> {
  const childId = await current.host.createAgent({
    steerable: false,
    labels: { [PARENT_AGENT_ID_LABEL]: parentId },
  });
  await current.host.startTurn(childId, `work for ${parentId}`);
  await current.delegations.delegate({
    parentAgentId: parentId,
    childAgentId: childId,
    source: "create_agent",
    title: "Child",
    prompt: "work",
    requireParentOwnership: true,
  });
  return childId;
}

test("Stop of an idle parent cancels its whole running subtree and nothing wakes it", async () => {
  const current = createScenario();
  const { host, agentStop, disposedWatches } = current;
  const parentId = await host.createAgent({ steerable: false });
  await host.startTurn(parentId, "delegate");
  const childId = await createRunningChild(current, parentId);
  const grandchildId = await createRunningChild(current, childId);
  host.session(parentId).completeTurn("waiting on the child");
  await host.agentManager.waitForRunToSettle(parentId);

  await expect(agentStop.stop(parentId)).resolves.toMatchObject({ cancelled: false });

  for (const agentId of [childId, grandchildId]) {
    expect(host.session(agentId).interruptCount).toBe(1);
    expect(host.agentManager.getAgent(agentId)?.lifecycle).toBe("idle");
    expect(host.agentManager.messageQueue.isHeldForUserStop(agentId)).toBe(true);
  }
  expect(disposedWatches).toEqual([parentId, childId, grandchildId]);
  await current.trace.waitFor("delegation.finalized", 2);
  await host.agentManager.waitForRunToSettle(parentId);
  expect(host.session(parentId).startPrompts).toEqual(["delegate"]);
  expect(host.agentManager.messageQueue.entries(parentId)).toEqual([]);
});

test("Stop skips archived descendants and keeps going past one that fails", async () => {
  const current = createScenario();
  const { host, trace } = current;
  const parentId = await host.createAgent({ steerable: false });
  await host.startTurn(parentId, "delegate");
  const brokenId = await createRunningChild(current, parentId);
  const healthyId = await createRunningChild(current, parentId);
  const archivedId = await createRunningChild(current, parentId);
  await host.agentManager.archiveAgent(archivedId);
  const agentStop = new AgentStop({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    delegations: {
      async stopAll(agentId) {
        if (agentId === brokenId) throw new Error("delegation file is damaged");
        await current.delegations.stopAll(agentId);
      },
    },
    pullRequestWatches: null,
    logger: trace.logger,
  });

  await expect(agentStop.stop(parentId)).resolves.toMatchObject({ cancelled: true });

  await trace.waitFor("agent.stop.descendant_failed");
  expect(host.session(brokenId).interruptCount).toBe(0);
  expect(host.session(healthyId).interruptCount).toBe(1);
  expect(host.agentManager.messageQueue.isHeldForUserStop(archivedId)).toBe(false);
});

test("a run that Stop reached is refused new work; the next run is not", async () => {
  const { host, agentStop } = createScenario();
  const agentId = await host.createAgent({ steerable: false });
  await host.startTurn(agentId, "first task");

  await agentStop.stop(agentId);

  expect(() => agentStop.assertRunNotStopped(agentId, "create_agent")).toThrow(
    AgentRunStoppedError,
  );
  await host.startTurn(agentId, "user asks again");
  expect(() => agentStop.assertRunNotStopped(agentId, "watch_pull_request")).not.toThrow();
});
