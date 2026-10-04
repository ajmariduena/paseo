import { afterEach, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { ControlledAgentClient } from "../test-utils/controlled-agent-client.js";

let daemon: TestPaseoDaemon | null = null;
let openClient: DaemonClient | null = null;

afterEach(async () => {
  await openClient?.close().catch(() => undefined);
  await daemon?.close();
  openClient = null;
  daemon = null;
}, 30_000);

async function startDaemon(): Promise<{ provider: ControlledAgentClient; client: DaemonClient }> {
  const provider = new ControlledAgentClient("claude", { steerable: false });
  daemon = await createTestPaseoDaemon({ agentClients: { claude: provider }, mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.0",
  });
  openClient = client;
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  return { provider, client };
}

test("the app queues behind a running turn, Stop holds the queue, and resume delivers it", async () => {
  const { provider, client } = await startDaemon();
  const agent = await client.createAgent({ provider: "claude", cwd: daemon!.paseoHome });
  await expect(client.sendAgentMessage(agent.id, "first task")).resolves.toEqual({
    disposition: "started",
  });
  const session = provider.latestSession();

  await expect(
    client.sendAgentMessage(agent.id, "second task", {
      messageId: "msg-second",
      activeTurnBehavior: "queue",
    }),
  ).resolves.toEqual({ disposition: "queued" });
  const queued = await client.waitForAgentUpsert(
    agent.id,
    (snapshot) => snapshot.queue?.entries.length === 1,
  );
  expect(queued.queue).toEqual({
    held: false,
    heldReason: null,
    entries: [
      {
        id: "msg-second",
        origin: "user",
        senderAgentId: null,
        position: 1,
        textPreview: "second task",
        attachmentCount: 0,
        createdAt: expect.any(String),
      },
    ],
  });

  await client.cancelAgent(agent.id);
  const held = await client.listAgentQueue(agent.id);
  expect(held.queue).toMatchObject({ held: true, heldReason: "user_stop" });
  expect(session.startPrompts).toEqual(["first task"]);

  const resumed = await client.resumeAgentQueue(agent.id);
  expect(resumed.accepted).toBe(true);
  await expect.poll(() => session.startPrompts).toEqual(["first task", "second task"]);
  expect((await client.listAgentQueue(agent.id)).queue).toEqual({
    held: false,
    heldReason: null,
    entries: [],
  });
});

test("a steer the provider cannot take still replaces the turn for the app, as before", async () => {
  const { provider, client } = await startDaemon();
  const agent = await client.createAgent({ provider: "claude", cwd: daemon!.paseoHome });
  await client.sendAgentMessage(agent.id, "first task");
  const session = provider.latestSession();

  await expect(
    client.sendAgentMessage(agent.id, "change of plan", { activeTurnBehavior: "steer" }),
  ).resolves.toEqual({ disposition: "started" });

  expect(session.interruptCount).toBe(1);
  expect(session.startPrompts).toEqual(["first task", "change of plan"]);
});
