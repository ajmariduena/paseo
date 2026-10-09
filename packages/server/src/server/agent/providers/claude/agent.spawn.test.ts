import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { asInternals } from "../../../test-utils/class-mocks.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../../utils/tree-kill.js";
import { ClaudeAgentClient } from "./agent.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(
  events: unknown[],
  options: {
    iterator?: AsyncGenerator<unknown, void, unknown>;
    onClose?: () => void;
    returnResult?: Promise<IteratorResult<unknown>>;
  } = {},
): Query {
  let index = 0;
  return {
    next: vi.fn(async () => {
      if (options.iterator) return options.iterator.next();
      return index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined };
    }),
    return: vi.fn(
      async () =>
        options.returnResult ?? options.iterator?.return() ?? { done: true, value: undefined },
    ),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => options.onClose?.()),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

function createChildProcessStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.exitCode = 0;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  return child;
}

describe("Claude spawn override", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("close drains received frames before returning the iterator or dropping subscribers", async () => {
    const shutdown = Promise.withResolvers<void>();
    const lastSessionId = "11111111-1111-4111-8111-111111111111";
    async function* frames(): AsyncGenerator<unknown, void, unknown> {
      yield {
        type: "system",
        subtype: "init",
        session_id: "old-session",
        permissionMode: "default",
        model: "opus",
      };
      yield {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
      };
      await shutdown.promise;
      yield { type: "assistant", message: { content: "queued before shutdown" } };
      yield {
        type: "system",
        subtype: "init",
        session_id: lastSessionId,
        permissionMode: "default",
        model: "opus",
      };
      yield { type: "assistant", message: { content: "final received frame" } };
    }
    const query = createQueryMock([], { iterator: frames(), onClose: () => shutdown.resolve() });
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => query,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.run("initial turn");
      await session.close();
      const text = events.filter(
        (event) => event.type === "timeline" && event.item.type === "assistant_message",
      );
      expect(text).toMatchObject([
        { item: { text: "queued before shutdown" } },
        { item: { text: `Claude switched to a new session: old-session -> ${lastSessionId}` } },
        { item: { text: "final received frame" } },
      ]);
      expect(session.describePersistence()?.sessionId).toBe(lastSessionId);
    } finally {
      shutdown.resolve();
      await session.close();
    }
  });

  test("restart drains the retiring query before choosing the replacement session", async () => {
    const shutdown = Promise.withResolvers<void>();
    const finalSessionId = "22222222-2222-4222-8222-222222222222";
    async function* frames(): AsyncGenerator<unknown, void, unknown> {
      yield {
        type: "system",
        subtype: "init",
        session_id: "old-session",
        permissionMode: "default",
        model: "opus",
      };
      yield {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
      };
      await shutdown.promise;
      yield {
        type: "system",
        subtype: "init",
        session_id: finalSessionId,
        permissionMode: "default",
        model: "opus",
      };
      yield { type: "assistant", message: { content: "retiring query tail" } };
    }
    const firstQuery = createQueryMock([], {
      iterator: frames(),
      onClose: () => shutdown.resolve(),
    });
    const replacementQuery = createQueryMock([]);
    const queryFactory = vi
      .fn(() => firstQuery)
      .mockReturnValueOnce(firstQuery)
      .mockReturnValue(replacementQuery);
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.run("initial turn");
      await session.setThinkingOption(null);
      await session.listCommands();
      expect(queryFactory).toHaveBeenLastCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ resume: finalSessionId }) }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({ text: "retiring query tail" }),
        }),
      );
      expect(firstQuery.return).toHaveBeenCalledTimes(1);
    } finally {
      shutdown.resolve();
      await session.close();
    }
  });

  test("native shutdown drains stdout before closing the SDK transport", async () => {
    const stopped = Promise.withResolvers<void>();
    const actions: string[] = [];
    async function* frames(): AsyncGenerator<unknown, void, unknown> {
      await stopped.promise;
      actions.push("stdout drained");
      yield {
        type: "system",
        subtype: "init",
        session_id: "final-session",
        permissionMode: "default",
        model: "opus",
      };
    }
    const query = createQueryMock([], {
      iterator: frames(),
      onClose: () => actions.push("transport closed"),
    });
    vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      processTerminator: async () => {
        actions.push("process stopped");
        stopped.resolve();
        return "terminated";
      },
      queryFactory: ({ options }) => {
        options.spawnClaudeCodeProcess?.({
          command: "node",
          args: ["claude.js"],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        });
        return query;
      },
    }).createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await session.listCommands();
      await session.close();
      expect(actions).toEqual(["process stopped", "stdout drained", "transport closed"]);
      expect(session.describePersistence()?.sessionId).toBe("final-session");
    } finally {
      stopped.resolve();
      await session.close();
    }
  });

  test("a timed out pump remains owned and drains on retry", async () => {
    vi.useFakeTimers();
    const drain = Promise.withResolvers<void>();
    async function* frames(): AsyncGenerator<unknown, void, unknown> {
      await drain.promise;
      yield { type: "assistant", message: { content: "late buffered frame" } };
    }
    const query = createQueryMock([], { iterator: frames() });
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => query,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.listCommands();
      const outcome = session.close().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await outcome).toMatchObject({
        message: "Claude message pump did not settle during close",
      });
      expect(query.return).not.toHaveBeenCalled();
      drain.resolve();
      await session.close();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({ text: "late buffered frame" }),
        }),
      );
      expect(query.return).toHaveBeenCalledTimes(1);
    } finally {
      drain.resolve();
      vi.useRealTimers();
      await session.close();
    }
  });

  test("a timed out query return refuses closure and retries the same operation", async () => {
    vi.useFakeTimers();
    const returned = Promise.withResolvers<IteratorResult<unknown>>();
    const query = createQueryMock([], { returnResult: returned.promise });
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => query,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await session.listCommands();
      const outcome = session.close().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await outcome).toBeInstanceOf(Error);
      returned.resolve({ done: true, value: undefined });
      await session.close();
      expect(query.return).toHaveBeenCalledTimes(1);
    } finally {
      returned.resolve({ done: true, value: undefined });
      vi.useRealTimers();
      await session.close();
    }
  });

  test("a rejected query return can be retried after its pump has drained", async () => {
    const query = createQueryMock([]);
    vi.mocked(query.return).mockRejectedValueOnce(new Error("query cleanup failed"));
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => query,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await session.listCommands();
      await expect(session.close()).rejects.toThrow("query cleanup failed");
      await session.close();
      expect(query.return).toHaveBeenCalledTimes(2);
      expect(query.close).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  test("a message handler failure still stops the transport and refuses later certification", async () => {
    const query = createQueryMock([{ type: "assistant", message: { content: "pending frame" } }]);
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => query,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const handler = vi
      .spyOn(
        asInternals<{ routeSdkMessageFromPump(): Promise<void> }>(session),
        "routeSdkMessageFromPump",
      )
      .mockRejectedValueOnce(new Error("message processing failed"));
    await session.listCommands();
    await expect(session.close()).rejects.toThrow("message processing failed");
    expect(query.close).toHaveBeenCalledTimes(1);
    handler.mockRestore();
    await expect(session.close()).rejects.toThrow("message processing failed");
    await expect(session.listCommands()).rejects.toThrow("Claude session is closed");
  });

  test("retains a runtime whose exit is uncertain and retries cleanup before closing its query", async () => {
    const query = createQueryMock([]);
    let stopped = 0;
    let childExit = Promise.resolve();
    let attempts = 0;
    const processTerminator: ProcessTerminator = async (child, options) => {
      attempts += 1;
      if (attempts === 1) return "kill-timeout";
      return terminateWithTreeKill(child, options);
    };
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => process.execPath,
      processTerminator,
      queryFactory: ({ options }) => {
        const spawn = options.spawnClaudeCodeProcess;
        if (!spawn) throw new Error("Missing provider process launcher");
        const child = spawn({
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        });
        childExit = new Promise<void>((resolve) =>
          child.on("exit", () => {
            stopped += 1;
            resolve();
          }),
        );
        return query;
      },
    }).createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await session.listCommands();
      await expect(session.close()).rejects.toThrow("Claude process tree exit is unconfirmed");
      expect(query.close).not.toHaveBeenCalled();
      await session.close();
      await childExit;
      expect(attempts).toBe(2);
      expect(query.close).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("bypasses the shell when spawning Claude Code", async () => {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "claude-spawn-shell-regression-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    try {
      await session.run("spawn shell regression");
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "node",
        args: ["claude.js", "--mcp-config", '{"mcpServers":{"paseo":{"type":"http"}}}'],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);
    } finally {
      await session.close();
    }

    const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
    expect(claudeSpawnCall).toBeDefined();
    const spawnOptions = claudeSpawnCall?.[2];
    expect(spawnOptions?.shell).toBe(false);
  });
});
