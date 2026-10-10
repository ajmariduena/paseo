import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HandoffOwnership } from "../handoff/ownership.js";
import { AgentQueueStore } from "./store.js";

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
let handoffDirectory: string | null = null;

afterEach(async () => {
  await activeHost?.cleanup();
  activeHost = null;
  if (handoffDirectory) await rm(handoffDirectory, { recursive: true, force: true });
  handoffDirectory = null;
});

async function createHandoffHost() {
  handoffDirectory = await mkdtemp(path.join(os.tmpdir(), "paseo-queue-handoff-"));
  const ownership = new HandoffOwnership({
    directory: path.join(handoffDirectory, "ownership"),
    sourceServerId: "source",
  });
  await ownership.initialize();
  const queueDirectory = path.join(handoffDirectory, "queues");
  const host = createControlledHost({
    handoffOwnership: ownership,
    messageQueueStore: new AgentQueueStore(queueDirectory),
  });
  activeHost = host;
  return { host, ownership, queueDirectory };
}

test.skipIf(process.platform === "win32")(
  "handoff preserves queued prompts through turn closure and only delivers after cancellation and resume",
  async () => {
    const { host, ownership, queueDirectory } = await createHandoffHost();
    const agentId = await host.createAgent({ steerable: false });
    await host.startTurn(agentId, "current task");
    const queued = await dispatchAgentMessageInBackground({
      agentManager: host.agentManager,
      agentStorage: host.agentStorage,
      agentId,
      messageId: "pending-task",
      policy: { intent: "queue", prompt: "do this next", steerUnavailable: "replace" },
      logger: host.logger,
    });
    let outcome = "pending";
    void queued.settled.then(
      (result) => {
        outcome = result;
        return outcome;
      },
      () => {
        outcome = "failed";
        return outcome;
      },
    );
    const transferId = randomUUID();
    await ownership.prepare({
      id: transferId,
      cwd: host.root,
      workspaceId: "workspace",
      agentIds: [agentId],
      destinationServerId: "destination",
      reservationId: randomUUID(),
    });
    host.session(agentId).completeTurn("current task done");
    const queue = host.agentManager.messageQueue;
    await expect.poll(() => queue.snapshot(agentId)?.held).toBe(true);
    expect(queue.entries(agentId).map((entry) => entry.id)).toEqual(["pending-task"]);
    expect(outcome).toBe("pending");
    expect(host.session(agentId).startPrompts).toEqual(["current task"]);
    const recovered = new AgentQueueStore(queueDirectory);
    await recovered.load();
    expect(recovered.peek(agentId)?.held).toBe(true);
    await expect(queue.resume(agentId)).rejects.toThrow("held by handoff");
    await expect(
      queue.enqueue(
        agentId,
        {
          id: "late-task",
          origin: "user",
          senderAgentId: null,
          textPreview: "",
          prompt: "late",
          wake: null,
        },
        async () => "started",
      ),
    ).rejects.toThrow("held by handoff");
    await expect(queue.edit(agentId, "pending-task", "changed")).rejects.toThrow("held by handoff");
    await expect(queue.cancel(agentId, "pending-task")).rejects.toThrow("held by handoff");
    await expect(queue.clear(agentId)).rejects.toThrow("held by handoff");
    await expect(queue.cancelForHandoff(agentId, "pending-task")).rejects.toThrow(
      "Only process-bound notifications",
    );
    await expect(queue.reorder(agentId, ["pending-task"])).rejects.toThrow("held by handoff");
    await expect(queue.promoteToSteer(agentId, "pending-task")).rejects.toThrow("held by handoff");
    await ownership.cancel(transferId);
    expect(queue.snapshot(agentId)?.held).toBe(true);
    await queue.resume(agentId);
    await expect(queued.settled).resolves.toBe("started");
    expect(host.session(agentId).startPrompts).toEqual(["current task", "do this next"]);
  },
);

test.skipIf(process.platform === "win32")(
  "a handoff arriving during queued delivery restores the exact prompt before draining admission",
  async () => {
    const { host, ownership, queueDirectory } = await createHandoffHost();
    const agentId = await host.createAgent({ steerable: false });
    await host.startTurn(agentId, "current task");
    const queue = host.agentManager.messageQueue;
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const prompt = [
      { type: "text" as const, text: "analyze this exact image" },
      { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" },
    ];
    const queued = await queue.enqueue(
      agentId,
      {
        id: "image-task",
        origin: "user",
        senderAgentId: null,
        textPreview: "",
        prompt,
        wake: null,
      },
      async () => {
        entered.resolve();
        await proceed.promise;
        return ownership.withMutation({ cwd: host.root, agentId }, async () => "started" as const);
      },
    );
    void queued.settled.catch(() => undefined);
    host.session(agentId).completeTurn("current done");
    await entered.promise;
    const transferId = randomUUID();
    await ownership.prepare({
      id: transferId,
      cwd: host.root,
      workspaceId: "workspace",
      agentIds: [agentId],
      destinationServerId: "destination",
      reservationId: randomUUID(),
    });
    proceed.resolve();
    await ownership.drain(transferId);
    await expect.poll(() => queue.snapshot(agentId)?.held).toBe(true);
    expect(queue.entries(agentId)).toEqual([queued.entry]);
    if (!queued.entry.promptFile) throw new Error("Missing queued prompt");
    expect(
      JSON.parse(
        await readFile(path.join(queueDirectory, agentId, queued.entry.promptFile), "utf8"),
      ),
    ).toEqual(prompt);
    await ownership.cancel(transferId);
    await queue.resume(agentId);
    await expect(queued.settled).resolves.toBe("started");
  },
);

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

function dispatchSystemMessage(host: ControlledHost, agentId: string, messageId: string) {
  const trace = createTraceRecorder();
  const settled = dispatchAgentMessage({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId,
    policy: {
      kind: "system",
      maySteer: true,
      prepare: async () => ({
        prompt: `<paseo-system>\n${messageId}\n</paseo-system>`,
        notification: { level: "info", message: messageId },
      }),
      queueAs: { origin: "system" },
    },
    logger: trace.logger,
  });
  return { settled, queued: trace.waitFor("agent.dispatch.wait_for_turn") };
}

async function stoppedIdleAgent(): Promise<{ host: ControlledHost; agentId: string }> {
  const host = createControlledHost();
  activeHost = host;
  const agentId = await host.createAgent({ steerable: true });
  await host.startTurn(agentId, "first task");
  await host.agentManager.messageQueue.hold(agentId, "user_stop");
  await host.agentManager.cancelAgentRun(agentId);
  await host.agentManager.waitForRunToSettle(agentId);
  return { host, agentId };
}

test("after a user Stop a system message waits in the held queue instead of starting a turn", async () => {
  const { host, agentId } = await stoppedIdleAgent();
  const session = host.session(agentId);

  const wake = dispatchSystemMessage(host, agentId, "pr-watch:1");
  await wake.queued;

  expect(session.startPrompts).toEqual(["first task"]);
  expect(host.agentManager.messageQueue.snapshot(agentId)).toMatchObject({
    held: true,
    heldReason: "user_stop",
    entries: [expect.objectContaining({ id: "pr-watch:1", origin: "system" })],
  });

  await host.agentManager.messageQueue.resume(agentId);
  await expect(wake.settled).resolves.toBe("started");
  expect(session.startPrompts).toEqual([
    "first task",
    "<paseo-system>\npr-watch:1\n</paseo-system>",
  ]);
});

test("a message from the user revives a stopped agent for later system messages", async () => {
  const { host, agentId } = await stoppedIdleAgent();
  const session = host.session(agentId);

  const userMessage = await dispatchAgentMessageInBackground({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "user-1",
    policy: { intent: "auto", prompt: "carry on", steerUnavailable: "replace" },
    logger: host.logger,
  });
  expect(userMessage.disposition).toBe("started");
  session.completeTurn("carried on");
  await host.agentManager.waitForRunToSettle(agentId);

  await expect(dispatchSystemMessage(host, agentId, "pr-watch:2").settled).resolves.toBe("started");
  expect(session.startPrompts).toEqual([
    "first task",
    "carry on",
    "<paseo-system>\npr-watch:2\n</paseo-system>",
  ]);
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
