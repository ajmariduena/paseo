import { afterEach, expect, test } from "vitest";

import {
  createControlledHost,
  createTraceRecorder,
  type ControlledHost,
} from "../test-utils/controlled-agent-client.js";
import {
  dispatchAgentMessage,
  dispatchAgentMessageInBackground,
  type BackgroundDispatch,
} from "../agent/message-dispatch.js";

let activeHost: ControlledHost | null = null;

afterEach(async () => {
  await activeHost?.cleanup();
  activeHost = null;
});

async function queueBehindTurn(
  input: { steerable: boolean },
  prompts: string[],
): Promise<{ host: ControlledHost; agentId: string; dispatches: BackgroundDispatch[] }> {
  const controlled = createControlledHost();
  activeHost = controlled;
  const agentId = await controlled.createAgent(input);
  await controlled.startTurn(agentId, "first task");
  const dispatches: BackgroundDispatch[] = [];
  for (const [index, prompt] of prompts.entries()) {
    dispatches.push(
      await dispatchAgentMessageInBackground({
        agentManager: controlled.agentManager,
        agentStorage: controlled.agentStorage,
        agentId,
        messageId: `msg-${index + 1}`,
        policy: { intent: "queue", prompt, steerUnavailable: "replace" },
        logger: controlled.logger,
      }),
    );
  }
  return { host: controlled, agentId, dispatches };
}

test("queued messages wait in the snapshot and start one per settled turn", async () => {
  const { host, agentId, dispatches } = await queueBehindTurn({ steerable: false }, [
    "second task",
    "third task",
  ]);
  const session = host.session(agentId);

  expect(dispatches.map((dispatch) => dispatch.disposition)).toEqual(["queued", "queued"]);
  expect(host.agentManager.messageQueue.snapshot(agentId)).toEqual({
    held: false,
    heldReason: null,
    entries: [
      expect.objectContaining({ id: "msg-1", origin: "user", textPreview: "second task" }),
      expect.objectContaining({ id: "msg-2", origin: "user", textPreview: "third task" }),
    ],
  });

  session.completeTurn("first done");
  await expect(dispatches[0]?.settled).resolves.toBe("started");
  expect(session.startPrompts).toEqual(["first task", "second task"]);
  expect(host.agentManager.messageQueue.snapshot(agentId)?.entries.map((e) => e.id)).toEqual([
    "msg-2",
  ]);

  session.completeTurn("second done");
  await expect(dispatches[1]?.settled).resolves.toBe("started");
  expect(session.startPrompts).toEqual(["first task", "second task", "third task"]);
  expect(host.agentManager.messageQueue.snapshot(agentId)).toBeNull();
  expect(session.interruptCount).toBe(0);
});

test("a failed turn holds the queue until it is resumed", async () => {
  const { host, agentId, dispatches } = await queueBehindTurn({ steerable: false }, [
    "second task",
  ]);
  const session = host.session(agentId);

  session.failTurn("provider exploded");
  await expect.poll(() => host.agentManager.messageQueue.snapshot(agentId)?.held).toBe(true);
  expect(host.agentManager.messageQueue.snapshot(agentId)?.heldReason).toBe("failure");
  expect(session.startPrompts).toEqual(["first task"]);

  await host.agentManager.messageQueue.resume(agentId);
  await expect(dispatches[0]?.settled).resolves.toBe("started");
  expect(session.startPrompts).toEqual(["first task", "second task"]);
});

test("a user Stop holds the queue so the stopped turn is not followed by the next message", async () => {
  const { host, agentId, dispatches } = await queueBehindTurn({ steerable: false }, [
    "second task",
  ]);
  const session = host.session(agentId);

  await host.agentManager.messageQueue.hold(agentId, "user_stop");
  await host.agentManager.cancelAgentRun(agentId);
  await host.agentManager.waitForRunToSettle(agentId);

  expect(session.startPrompts).toEqual(["first task"]);
  expect(host.agentManager.messageQueue.snapshot(agentId)).toMatchObject({
    held: true,
    heldReason: "user_stop",
  });

  await host.agentManager.messageQueue.resume(agentId);
  await expect(dispatches[0]?.settled).resolves.toBe("started");
});

test("a delegation wake queued after user messages starts first", async () => {
  const { host, agentId, dispatches } = await queueBehindTurn({ steerable: false }, [
    "second task",
  ]);
  const session = host.session(agentId);
  const trace = createTraceRecorder();

  const wake = dispatchAgentMessage({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "wake:parent:run-1:1",
    policy: {
      kind: "system",
      maySteer: true,
      prepare: async () => ({
        prompt: "<paseo-system>\nchild finished\n</paseo-system>",
        notification: { level: "info", message: "Review finished" },
      }),
      queueAs: { origin: "delegation_wake", wake: { cohortKey: "run-1", generation: 1 } },
    },
    logger: trace.logger,
  });
  await trace.waitFor("agent.dispatch.wait_for_turn");
  expect(host.agentManager.messageQueue.snapshot(agentId)?.entries.map((e) => e.origin)).toEqual([
    "delegation_wake",
    "user",
  ]);

  session.completeTurn("first done");
  await expect(wake).resolves.toBe("started");
  expect(session.startPrompts).toEqual([
    "first task",
    "<paseo-system>\nchild finished\n</paseo-system>",
  ]);
  session.completeTurn("woke");
  await expect(dispatches[0]?.settled).resolves.toBe("started");
});

test("promoting a queued message steers it into the running turn", async () => {
  const { host, agentId, dispatches } = await queueBehindTurn({ steerable: true }, ["second task"]);
  const session = host.session(agentId);

  await expect(host.agentManager.messageQueue.promoteToSteer(agentId, "msg-1")).resolves.toBe(
    "steered",
  );

  await expect(dispatches[0]?.settled).resolves.toBe("steered");
  expect(session.steerPrompts).toEqual(["second task"]);
  expect(host.agentManager.messageQueue.snapshot(agentId)).toBeNull();
});

test("a cancelled message is dropped and an edited one is delivered with its new text", async () => {
  const { host, agentId, dispatches } = await queueBehindTurn({ steerable: false }, [
    "second task",
    "third task",
  ]);
  const session = host.session(agentId);
  const queue = host.agentManager.messageQueue;

  await queue.cancel(agentId, "msg-1");
  await queue.edit(agentId, "msg-2", "third task, revised");
  await expect(dispatches[0]?.settled).resolves.toBe("dropped");

  session.completeTurn("first done");
  await expect(dispatches[1]?.settled).resolves.toBe("started");
  expect(session.startPrompts).toEqual(["first task", "third task, revised"]);
});
