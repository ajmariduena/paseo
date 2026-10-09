import { expect, test } from "vitest";

import { readTurnSubmissionOutcome, type AgentSessionConfig } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

interface JsonRpcFailure {
  __jsonRpcError: { code: number; message: string };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function lostTurnStart(): JsonRpcFailure {
  return { __jsonRpcError: { code: -32000, message: "turn/start lost" } };
}

function createSession(appServer: FakeCodexAppServer): CodexAppServerAgentSession {
  const config: AgentSessionConfig = {
    provider: "codex",
    cwd: "/workspace/project",
    modeId: "auto",
    model: "gpt-5.4",
  };
  return new CodexAppServerAgentSession(
    config,
    null,
    createTestLogger(),
    async () => appServer.child,
  );
}

/** Holds the turn/start response until the test decides how it ends. */
function createSessionWithHeldTurnStart() {
  const response = deferred<JsonRpcFailure | Record<string, never>>();
  const appServer = createFakeCodexAppServer({ "turn/start": () => response.promise });
  return { appServer, session: createSession(appServer), response };
}

async function failure(start: Promise<unknown>): Promise<unknown> {
  return start.then(
    () => {
      throw new Error("startTurn was expected to reject");
    },
    (error: unknown) => error,
  );
}

test("a correlated turn/start response proves acceptance", async () => {
  const appServer = createFakeCodexAppServer();
  const session = createSession(appServer);

  const started = await session.startTurn("hello");

  expect(started.turnId).toMatch(/.+/);
  expect(await started.submission).toBe("accepted");
  appServer.assertNoErrors();
  await session.close();
});

test("root turn/started keeps acceptance through completion when the response is lost later", async () => {
  const { appServer, session, response } = createSessionWithHeldTurnStart();

  const start = session.startTurn("hello");
  await appServer.waitForTurnStart();
  appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
  appServer.completeTurn({ threadId: "thread-1" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  response.resolve(lostTurnStart());

  expect(readTurnSubmissionOutcome(await failure(start))).toBe("accepted");
  await session.close();
});

test("root turn/started keeps acceptance when the app-server exits before answering", async () => {
  const { appServer, session } = createSessionWithHeldTurnStart();

  const start = session.startTurn("hello");
  await appServer.waitForTurnStart();
  appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  appServer.disconnect();

  expect(readTurnSubmissionOutcome(await failure(start))).toBe("accepted");
  await session.close();
});

test("root turn/started keeps acceptance when the session closes before the answer", async () => {
  const { appServer, session } = createSessionWithHeldTurnStart();

  const start = session.startTurn("hello");
  await appServer.waitForTurnStart();
  appServer.startsTurn({ threadId: "thread-1", turnId: "native-1" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const closing = session.close();

  expect(readTurnSubmissionOutcome(await failure(start))).toBe("accepted");
  await closing;
});

test("a response error without root turn/started leaves the outcome unknown", async () => {
  const appServer = createFakeCodexAppServer({ "turn/start": () => lostTurnStart() });
  const session = createSession(appServer);

  expect(readTurnSubmissionOutcome(await failure(session.startTurn("hello")))).toBe("unknown");
  await session.close();
});

test("a child thread starting a turn is not acceptance of the root prompt", async () => {
  const { appServer, session, response } = createSessionWithHeldTurnStart();

  const start = session.startTurn("hello");
  await appServer.waitForTurnStart();
  appServer.startsSubAgent({ callId: "call-1", threadId: "child-thread", agentPath: "worker" });
  appServer.startsTurn({ threadId: "child-thread", turnId: "child-turn" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  response.resolve(lostTurnStart());

  expect(readTurnSubmissionOutcome(await failure(start))).toBe("unknown");
  await session.close();
});

test("a failure before the turn/start write proves the prompt was unsent", async () => {
  const appServer = createFakeCodexAppServer({
    "thread/start": () => ({ __jsonRpcError: { code: -32000, message: "no thread for you" } }),
  });
  const session = createSession(appServer);

  const error = await failure(session.startTurn("hello"));

  expect(error).toBeInstanceOf(Error);
  expect(readTurnSubmissionOutcome(error)).toBe("unsent");
  expect(appServer.requests().some((request) => request.method === "turn/start")).toBe(false);
  await session.close();
});

test("a closed session refuses to start with an unsent tag", async () => {
  const appServer = createFakeCodexAppServer();
  const session = createSession(appServer);
  await session.close();

  expect(readTurnSubmissionOutcome(await failure(session.startTurn("hello")))).toBe("unsent");
});
