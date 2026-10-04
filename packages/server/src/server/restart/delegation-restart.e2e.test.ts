import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { experimental_createMCPClient } from "ai";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { DelegationFile } from "../delegation/delegation-store.js";
import { ControlledAgentClient } from "../test-utils/controlled-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

interface RunningDaemon {
  daemon: TestPaseoDaemon;
  provider: ControlledAgentClient;
  client: DaemonClient;
}

let homeRoot: string;
let histories: Map<string, AgentStreamEvent[]>;
const running = new Set<RunningDaemon>();

beforeEach(async () => {
  homeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-restart-"));
  histories = new Map();
});

afterEach(async () => {
  for (const instance of running) await stopDaemon(instance);
  await rm(homeRoot, { recursive: true, force: true });
}, 30_000);

async function startDaemon(): Promise<RunningDaemon> {
  const provider = new ControlledAgentClient("claude", { steerable: false, histories });
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: homeRoot,
    cleanup: false,
    agentClients: { claude: provider },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.0",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const instance = { daemon, provider, client };
  running.add(instance);
  return instance;
}

async function stopDaemon(instance: RunningDaemon): Promise<void> {
  running.delete(instance);
  await instance.client.close().catch(() => undefined);
  await instance.daemon.close();
}

async function createChild(instance: RunningDaemon, parentAgentId: string): Promise<string> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${instance.daemon.port}/mcp/agents?callerAgentId=${parentAgentId}`),
  );
  const mcp = await experimental_createMCPClient({ transport });
  try {
    const result = await mcp.callTool({
      name: "create_agent",
      args: { title: "Review auth", provider: "claude/controlled", initialPrompt: "review auth" },
    });
    const content = Reflect.get(result, "structuredContent");
    const agentId: unknown = content && Reflect.get(content, "agentId");
    if (typeof agentId !== "string") throw new Error("create_agent returned no agentId");
    return agentId;
  } finally {
    await mcp.close();
  }
}

function sessionOf(instance: RunningDaemon, agentId: string) {
  const sessionId = instance.daemon.daemon.agentManager.getAgent(agentId)?.persistence?.sessionId;
  if (!sessionId) throw new Error(`Agent ${agentId} is not loaded`);
  return instance.provider.sessionFor(sessionId);
}

function delegationPath(parentAgentId: string): string {
  return path.join(homeRoot, ".paseo", "delegations", `${parentAgentId}.json`);
}

async function readDelegations(parentAgentId: string): Promise<DelegationFile> {
  return JSON.parse(await readFile(delegationPath(parentAgentId), "utf8")) as DelegationFile;
}

async function waitForStartPrompts(instance: RunningDaemon, agentId: string, count: number) {
  await expect
    .poll(() => {
      const loaded = instance.daemon.daemon.agentManager.getAgent(agentId);
      return loaded ? sessionOf(instance, agentId).startPrompts.length : 0;
    })
    .toBe(count);
  return sessionOf(instance, agentId).startPrompts;
}

test("a child cut by a restart reports cancelled and wakes its idle parent", async () => {
  const first = await startDaemon();
  const parent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
  const childId = await createChild(first, parent.id);
  await expect.poll(async () => (await readDelegations(parent.id)).tasks).not.toEqual({});
  await stopDaemon(first);

  const second = await startDaemon();
  const [wake] = await waitForStartPrompts(second, parent.id, 1);

  expect(wake).toContain(`Delegated task`);
  expect(wake).toContain(`agent ${childId}, "Review auth") was stopped.`);
  expect(wake).toContain("Child task ended with status cancelled.");
  const [task] = Object.values((await readDelegations(parent.id)).tasks);
  expect(task).toMatchObject({ childAgentId: childId, status: "cancelled" });
});

test("a queued wake and a queued user message stay held until agent.queue.resume", async () => {
  const first = await startDaemon();
  const parent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
  await first.client.sendAgentMessage(parent.id, "parent task");
  const childId = await createChild(first, parent.id);
  sessionOf(first, childId).completeTurn("auth looks fine");
  await first.client.waitForAgentUpsert(parent.id, (agent) => agent.queue?.entries.length === 1);
  await first.client.sendAgentMessage(parent.id, "user follow-up", { activeTurnBehavior: "queue" });
  await stopDaemon(first);

  const second = await startDaemon();
  const held = await second.client.listAgentQueue(parent.id);
  expect(held.queue).toMatchObject({
    held: true,
    heldReason: "restart",
    entries: [
      { origin: "delegation_wake", textPreview: "Review auth finished" },
      { origin: "user", textPreview: "user follow-up" },
    ],
  });
  expect(second.daemon.daemon.agentManager.getAgent(parent.id)).toBeNull();

  await second.client.resumeAgentQueue(parent.id);
  const [wake] = await waitForStartPrompts(second, parent.id, 1);
  expect(wake).toContain("auth looks fine");
  sessionOf(second, parent.id).completeTurn("noted");
  const prompts = await waitForStartPrompts(second, parent.id, 2);
  expect(prompts[1]).toBe("user follow-up");
});

test("a wake claimed but never dispatched before a crash is offered once", async () => {
  const first = await startDaemon();
  const parent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
  await first.client.sendAgentMessage(parent.id, "parent task");
  const childId = await createChild(first, parent.id);
  sessionOf(first, childId).completeTurn("auth looks fine");
  await first.client.waitForAgentUpsert(parent.id, (agent) => agent.queue?.entries.length === 1);
  await stopDaemon(first);
  // The state a crash between claiming the wake and queueing it leaves behind.
  const file = await readDelegations(parent.id);
  for (const cohort of Object.values(file.cohorts)) {
    if (cohort.delivery) cohort.delivery.dispatch = { kind: "none" };
  }
  await writeFile(delegationPath(parent.id), JSON.stringify(file));
  await rm(path.join(homeRoot, ".paseo", "agent-queues", `${parent.id}.json`));

  const second = await startDaemon();
  const [wake] = await waitForStartPrompts(second, parent.id, 1);
  expect(wake).toContain("auth looks fine");
  sessionOf(second, parent.id).completeTurn("noted");

  await expect
    .poll(async () => Object.values((await readDelegations(parent.id)).cohorts)[0]?.delivery)
    .toBeNull();
  expect(sessionOf(second, parent.id).startPrompts).toHaveLength(1);
  expect(Object.values((await readDelegations(parent.id)).tasks)[0]?.completionDelivery.state).toBe(
    "delivered",
  );
});

test("a wake turn cut by a restart hands its results to a successor wake", async () => {
  const first = await startDaemon();
  const parent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
  const childId = await createChild(first, parent.id);
  sessionOf(first, childId).completeTurn("auth looks fine");
  await waitForStartPrompts(first, parent.id, 1);
  await stopDaemon(first);
  const cut = Object.values((await readDelegations(parent.id)).cohorts)[0]?.delivery;
  expect(cut?.dispatch.kind).toBe("started");

  const second = await startDaemon();
  const [successor] = await waitForStartPrompts(second, parent.id, 1);

  expect(successor).toContain("auth looks fine");
  const outstanding = Object.values((await readDelegations(parent.id)).cohorts)[0]?.delivery;
  expect(outstanding).toMatchObject({ generation: (cut?.generation ?? 0) + 1 });
});

test("a wake re-sent under its id after a crash shows one notification row", async () => {
  const first = await startDaemon();
  const parent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
  const childId = await createChild(first, parent.id);
  sessionOf(first, childId).completeTurn("auth looks fine");
  const [sent] = await waitForStartPrompts(first, parent.id, 1);
  await stopDaemon(first);
  // The provider got the wake, but the crash came before the daemon recorded that it started.
  const file = await readDelegations(parent.id);
  const delivery = Object.values(file.cohorts)[0]?.delivery;
  if (!delivery) throw new Error("expected an outstanding wake");
  delivery.dispatch = { kind: "none" };
  await writeFile(delegationPath(parent.id), JSON.stringify(file));

  const second = await startDaemon();
  const prompts = await waitForStartPrompts(second, parent.id, 1);
  expect(prompts).toEqual([sent]);

  const rows = second.daemon.daemon.agentManager
    .getTimeline(parent.id)
    .filter((item) => item.type === "notification" || item.type === "user_message");
  expect(rows).toEqual([
    expect.objectContaining({ type: "notification", messageId: delivery.messageId }),
  ]);
});

test("a child that settled before a crash reports the result its history holds", async () => {
  const first = await startDaemon();
  const parent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
  const childId = await createChild(first, parent.id);
  await expect.poll(async () => (await readDelegations(parent.id)).tasks).not.toEqual({});
  const recorded = await readDelegations(parent.id);
  sessionOf(first, childId).completeTurn("auth looks fine");
  await waitForStartPrompts(first, parent.id, 1);
  await stopDaemon(first);
  // The state a crash between the child settling and its result being recorded leaves behind.
  await writeFile(delegationPath(parent.id), JSON.stringify(recorded));

  const second = await startDaemon();
  const [wake] = await waitForStartPrompts(second, parent.id, 1);

  expect(wake).toContain(`agent ${childId}, "Review auth") finished.`);
  expect(wake).toContain("auth looks fine");
});
