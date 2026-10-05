import { afterEach, expect, test } from "vitest";

import {
  createControlledHost,
  createTraceRecorder,
  SteerableControlledAgentSession,
  type ControlledHost,
} from "../test-utils/controlled-agent-client.js";
import {
  dispatchAgentMessage,
  dispatchAgentMessageInBackground,
  isMessageAlreadyDispatched,
  resolveDispatchIntent,
  SteerUnavailableError,
  type DispatchIntent,
  type DispatchTarget,
} from "./message-dispatch.js";

const IDLE: DispatchTarget = { run: null, canSteer: true };
const PENDING: DispatchTarget = { run: { key: "run-1", started: false }, canSteer: true };
const RUNNING_STEERABLE: DispatchTarget = { run: { key: "run-1", started: true }, canSteer: true };
const RUNNING_PLAIN: DispatchTarget = { run: { key: "run-1", started: true }, canSteer: false };

test.each<[string, DispatchTarget, DispatchIntent, ReturnType<typeof resolveDispatchIntent>]>([
  ["idle", IDLE, "auto", { kind: "start" }],
  ["idle", IDLE, "steer", { kind: "start" }],
  ["idle", IDLE, "restart", { kind: "start" }],
  ["idle", IDLE, "queue", { kind: "start" }],
  ["pending", PENDING, "auto", { kind: "queue" }],
  ["pending", PENDING, "steer", { kind: "steer", runKey: "run-1" }],
  ["pending", PENDING, "restart", { kind: "restart", runKey: "run-1" }],
  ["pending", PENDING, "queue", { kind: "queue" }],
  ["running steerable", RUNNING_STEERABLE, "auto", { kind: "steer", runKey: "run-1" }],
  ["running plain", RUNNING_PLAIN, "auto", { kind: "queue" }],
  ["running plain", RUNNING_PLAIN, "steer", { kind: "steer", runKey: "run-1" }],
  ["running plain", RUNNING_PLAIN, "restart", { kind: "restart", runKey: "run-1" }],
  ["running steerable", RUNNING_STEERABLE, "queue", { kind: "queue" }],
])("%s agent with %s intent resolves to %j", (_label, target, intent, expected) => {
  expect(resolveDispatchIntent(target, intent)).toEqual(expected);
});

let host: ControlledHost | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
});

test("a late steer becomes a new turn with the same messageId", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: true });
  await host.startTurn(agentId, "first task");
  const session = host.session(agentId);
  if (!(session instanceof SteerableControlledAgentSession)) throw new Error("not steerable");
  session.steerOutcome = "late";

  const disposition = await dispatchAgentMessage({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "msg-late",
    policy: { kind: "intent", intent: "auto", prompt: "follow-up", steerUnavailable: "fail" },
    logger: host.logger,
  });

  expect(disposition).toBe("started");
  expect(session.startPrompts).toEqual(["first task", "follow-up"]);
  expect(session.interruptCount).toBe(0);
  expect(host.agentManager.getTimeline(agentId)).toContainEqual({
    type: "user_message",
    text: "follow-up",
    clientMessageId: "msg-late",
    messageId: "msg-late",
  });
});

test("a steered system message reaches the provider as its prompt and the timeline as a notification", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: true });
  await host.startTurn(agentId, "first task");
  const session = host.session(agentId);
  if (!(session instanceof SteerableControlledAgentSession)) throw new Error("not steerable");
  const notification = {
    level: "info" as const,
    message: "Review auth needs permission",
    source: {
      kind: "subagent" as const,
      subagents: [
        { agentId: "child-1", reason: "needs_permission" as const, title: "Review auth" },
      ],
    },
  };

  const disposition = await dispatchAgentMessage({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "perm:child-1:request-1",
    policy: {
      kind: "system",
      maySteer: true,
      prepare: async () => ({ prompt: "<paseo-system>\nask\n</paseo-system>", notification }),
      queueAs: { origin: "system" },
    },
    logger: host.logger,
  });

  expect(disposition).toBe("steered");
  expect(session.steerPrompts).toEqual(["<paseo-system>\nask\n</paseo-system>"]);
  const timeline = host.agentManager.getTimeline(agentId);
  expect(timeline.filter((item) => item.type === "user_message")).toEqual([]);
  expect(timeline).toContainEqual({
    type: "notification",
    messageId: "perm:child-1:request-1",
    ...notification,
  });
});

test("a prompt another agent sent records its origin on the user message", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: false });

  await dispatchAgentMessage({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "mcp:parent:1",
    policy: {
      kind: "intent",
      intent: "auto",
      prompt: "Review the diff",
      steerUnavailable: "fail",
      origin: { kind: "agent", agentId: "parent-agent" },
    },
    logger: host.logger,
  });

  expect(host.agentManager.getTimeline(agentId)).toContainEqual({
    type: "user_message",
    text: "Review the diff",
    clientMessageId: "mcp:parent:1",
    messageId: "mcp:parent:1",
    origin: { kind: "agent", agentId: "parent-agent" },
  });
});

test("a queued message waits for the running turn instead of replacing it", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: false });
  await host.startTurn(agentId, "first task");
  const session = host.session(agentId);
  const trace = createTraceRecorder();

  const delivered = dispatchAgentMessage({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "msg-queued",
    policy: { kind: "intent", intent: "auto", prompt: "next task", steerUnavailable: "fail" },
    logger: trace.logger,
  });
  await trace.waitFor("agent.dispatch.wait_for_turn");
  expect(session.startPrompts).toEqual(["first task"]);
  session.completeTurn("first done");

  await expect(delivered).resolves.toBe("started");
  expect(session.startPrompts).toEqual(["first task", "next task"]);
  expect(session.interruptCount).toBe(0);
});

test("a sent message waits for a busy turn instead of replacing it", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: true });
  await host.startTurn(agentId, "/compact");
  const session = host.session(agentId);
  if (!(session instanceof SteerableControlledAgentSession)) throw new Error("not steerable");
  session.steerOutcome = "busy";
  const trace = createTraceRecorder();

  const delivered = dispatchAgentMessage({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "msg-during-compact",
    policy: { kind: "intent", intent: "auto", prompt: "next task", steerUnavailable: "replace" },
    logger: trace.logger,
  });
  await trace.waitFor("agent.dispatch.wait_for_turn");
  expect(session.interruptCount).toBe(0);
  session.completeTurn("compacted");

  await expect(delivered).resolves.toBe("started");
  expect(session.startPrompts).toEqual(["/compact", "next task"]);
  expect(session.interruptCount).toBe(0);
});

test("an explicit steer the provider cannot take fails without touching the turn", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: false });
  await host.startTurn(agentId, "first task");
  const session = host.session(agentId);

  await expect(
    dispatchAgentMessage({
      agentManager: host.agentManager,
      agentStorage: host.agentStorage,
      agentId,
      messageId: "msg-steer",
      policy: { kind: "intent", intent: "steer", prompt: "steer this", steerUnavailable: "fail" },
      logger: host.logger,
    }),
  ).rejects.toBeInstanceOf(SteerUnavailableError);
  expect(session.startPrompts).toEqual(["first task"]);
  expect(session.interruptCount).toBe(0);
});

test("a restart replaces the running turn and says so", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: true });
  await host.startTurn(agentId, "first task");
  const session = host.session(agentId);

  const disposition = await dispatchAgentMessage({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "msg-restart",
    policy: { kind: "intent", intent: "restart", prompt: "start over", steerUnavailable: "fail" },
    logger: host.logger,
  });

  expect(disposition).toBe("restarted");
  expect(session.interruptCount).toBe(1);
  expect(session.startPrompts).toEqual(["first task", "start over"]);
});

test("a background dispatch reports queued and keeps the message pending until it starts", async () => {
  host = createControlledHost();
  const agentId = await host.createAgent({ steerable: false });
  await host.startTurn(agentId, "first task");
  const session = host.session(agentId);

  const dispatch = await dispatchAgentMessageInBackground({
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    agentId,
    messageId: "msg-queued",
    policy: { intent: "queue", prompt: "next task", steerUnavailable: "fail" },
    logger: host.logger,
  });

  expect(dispatch.disposition).toBe("queued");
  expect(isMessageAlreadyDispatched(host.agentManager, agentId, "msg-queued")).toBe(true);
  session.completeTurn("first done");
  await expect(dispatch.settled).resolves.toBe("started");
  expect(session.startPrompts).toEqual(["first task", "next task"]);
  expect(isMessageAlreadyDispatched(host.agentManager, agentId, "msg-queued")).toBe(true);
});
