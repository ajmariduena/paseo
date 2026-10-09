import { expect, test } from "vitest";

import { readTurnSubmissionOutcome, type AgentSessionConfig } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  CodexAppServerClientClosedError,
  CodexAppServerRpcError,
} from "./codex/app-server-transport.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals, createStub } from "../../test-utils/class-mocks.js";

interface CodexClientLike {
  request: (method: string, ...rest: unknown[]) => Promise<unknown>;
}

interface CodexSessionInternals {
  connectionState: "disconnected" | "history-ready" | "connected";
  currentThreadId: string | null;
  client: CodexClientLike | null;
  handleNotification(method: string, params: unknown): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createConnectedSession(turnStart: () => Promise<unknown>) {
  const config: AgentSessionConfig = {
    provider: "codex",
    cwd: "/tmp/codex-submission-test",
    modeId: "auto",
    model: "gpt-5.4",
  };
  const session = new CodexAppServerAgentSession(config, null, createTestLogger(), () => {
    throw new Error("Test session cannot spawn Codex app-server");
  });
  const internals = asInternals<CodexSessionInternals>(session);
  internals.connectionState = "connected";
  internals.currentThreadId = "test-thread";
  internals.client = createStub<CodexClientLike>({
    request: async (method) => {
      if (method === "thread/loaded/list") return { data: ["test-thread"] };
      if (method === "turn/start") return turnStart();
      throw new Error(`Unexpected request: ${method}`);
    },
  });
  return { session, internals };
}

test("a correlated turn/start response proves acceptance", async () => {
  const { session } = createConnectedSession(async () => ({}));

  const started = await session.startTurn("hello");

  expect(started.turnId).toMatch(/.+/);
  expect(await started.submission).toBe("accepted");
});

test("root turn/started proves acceptance even when the response is lost afterwards", async () => {
  const response = deferred<unknown>();
  const { session, internals } = createConnectedSession(() => response.promise);

  const start = session.startTurn("hello");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  internals.handleNotification("turn/started", { turn: { id: "native-turn-1" } });
  response.reject(new Error("Codex app-server request timed out for turn/start"));

  const failure = await start.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(readTurnSubmissionOutcome(failure)).toBe("accepted");
});

test("a response error without turn/started leaves the outcome unknown", async () => {
  const { session } = createConnectedSession(async () => {
    throw new CodexAppServerRpcError("model unavailable", -32000, null);
  });

  const failure = await session.startTurn("hello").catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(CodexAppServerRpcError);
  expect(readTurnSubmissionOutcome(failure)).toBe("unknown");
});

test("a client closed before the write proves the prompt was unsent", async () => {
  const { session } = createConnectedSession(async () => {
    throw new CodexAppServerClientClosedError();
  });

  const failure = await session.startTurn("hello").catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(CodexAppServerClientClosedError);
  expect(readTurnSubmissionOutcome(failure)).toBe("unsent");
});

test("a failure before the turn/start write proves the prompt was unsent", async () => {
  const { session, internals } = createConnectedSession(async () => ({}));
  internals.client = createStub<CodexClientLike>({
    request: async (method) => {
      throw new Error(`thread load failed during ${method}`);
    },
  });

  const failure = await session.startTurn("hello").catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(readTurnSubmissionOutcome(failure)).toBe("unsent");
});
