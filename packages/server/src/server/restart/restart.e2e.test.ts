import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { experimental_createMCPClient } from "ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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

async function startDaemon(
  options: { continueAfterRestart?: boolean } = {},
): Promise<RunningDaemon> {
  const provider = new ControlledAgentClient("claude", { steerable: false, histories });
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: homeRoot,
    cleanup: false,
    agentClients: { claude: provider },
    continueAfterRestart: options.continueAfterRestart,
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

async function readRecord(instance: RunningDaemon, agentId: string) {
  return await instance.daemon.daemon.agentStorage.get(agentId);
}

async function editRecord(
  agentId: string,
  edit: (record: Record<string, unknown>) => void,
): Promise<void> {
  const agentsDir = path.join(homeRoot, ".paseo", "agents");
  for (const entry of await readdir(agentsDir, { recursive: true })) {
    if (path.basename(entry) !== `${agentId}.json`) continue;
    const filePath = path.join(agentsDir, entry);
    const record = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    edit(record);
    await writeFile(filePath, JSON.stringify(record));
    return;
  }
  throw new Error(`No record for agent ${agentId}`);
}

describe("restart continuation", () => {
  test("a cut turn continues with one stable-id prompt shown as a notification", async () => {
    const first = await startDaemon();
    const agent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
    await first.client.sendAgentMessage(agent.id, "long task");
    const runKey = first.daemon.daemon.agentManager.getActiveRun(agent.id)?.key;
    await stopDaemon(first);

    const second = await startDaemon({ continueAfterRestart: true });
    const prompts = await waitForStartPrompts(second, agent.id, 1);

    expect(prompts).toEqual(["Continue where you left off."]);
    expect(second.daemon.daemon.agentManager.getTimeline(agent.id)).toContainEqual({
      type: "notification",
      level: "info",
      message: "Continued after the daemon restarted",
      messageId: `restart-continuation:${agent.id}:${runKey}`,
    });
  });

  test("with the setting off a cut turn stays stopped", async () => {
    const first = await startDaemon();
    const agent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
    await first.client.sendAgentMessage(agent.id, "long task");
    await stopDaemon(first);

    const second = await startDaemon();
    await second.client.sendAgentMessage(agent.id, "what happened?");

    expect(sessionOf(second, agent.id).startPrompts).toEqual(["what happened?"]);
  });

  test("an idle agent that lost background work stays asleep and its next prompt carries the note once", async () => {
    const first = await startDaemon({ continueAfterRestart: true });
    const agent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
    await first.client.sendAgentMessage(agent.id, "start the dev server");
    const firstSession = sessionOf(first, agent.id);
    firstSession.setBackgroundTasks([
      {
        id: "bg-1",
        taskType: "shell",
        description: "npm run dev",
        startedAt: "2026-10-04T12:00:00.000Z",
      },
    ]);
    firstSession.completeTurn("dev server is up");
    await first.client.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.status === "idle" && (snapshot.backgroundTasks?.length ?? 0) === 1,
    );
    await stopDaemon(first);

    const second = await startDaemon({ continueAfterRestart: true });
    expect(second.daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();
    expect((await readRecord(second, agent.id))?.pendingRestartNote).toEqual([
      { kind: "shell", label: "npm run dev", id: "bg-1" },
    ]);

    await second.client.sendAgentMessage(agent.id, "is it still running?");
    const [withNote] = await waitForStartPrompts(second, agent.id, 1);
    expect(withNote).toBe(
      [
        "Note: the Paseo daemon restarted, and this background work was cancelled before it finished. It will not report back:",
        "- shell: npm run dev",
        "",
        "is it still running?",
      ].join("\n"),
    );
    sessionOf(second, agent.id).completeTurn("it stopped");
    await expect
      .poll(async () => (await readRecord(second, agent.id))?.pendingRestartNote)
      .toBeUndefined();

    await second.client.sendAgentMessage(agent.id, "start it again");
    const prompts = await waitForStartPrompts(second, agent.id, 2);
    expect(prompts[1]).toBe("start it again");
  });

  test("a continued child reports its result once its continued turn settles", async () => {
    const first = await startDaemon();
    const parent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
    const childId = await createChild(first, parent.id);
    await expect.poll(async () => (await readDelegations(parent.id)).tasks).not.toEqual({});
    await stopDaemon(first);

    const second = await startDaemon({ continueAfterRestart: true });
    expect(await waitForStartPrompts(second, childId, 1)).toEqual(["Continue where you left off."]);
    expect(Object.values((await readDelegations(parent.id)).tasks)[0]?.status).toBe("running");

    sessionOf(second, childId).completeTurn("auth reviewed after the restart");
    const [wake] = await waitForStartPrompts(second, parent.id, 1);
    expect(wake).toContain(`agent ${childId}, "Review auth") finished.`);
    expect(wake).toContain("auth reviewed after the restart");
  });

  test("a delegated child whose continuation declines still reports to its parent", async () => {
    const first = await startDaemon();
    const parent = await first.client.createAgent({ provider: "claude", cwd: homeRoot });
    const childId = await createChild(first, parent.id);
    await expect.poll(async () => (await readDelegations(parent.id)).tasks).not.toEqual({});
    await stopDaemon(first);
    await editRecord(childId, (record) => {
      record["lastUserMessageAt"] = "2999-01-01T00:00:00.000Z";
    });

    const second = await startDaemon({ continueAfterRestart: true });
    const [wake] = await waitForStartPrompts(second, parent.id, 1);

    expect(wake).toContain(`agent ${childId}, "Review auth") was stopped.`);
    expect(wake).toContain("Child task ended with status cancelled.");
  });
});
