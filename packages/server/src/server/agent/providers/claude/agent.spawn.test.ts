import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
} from "../../../managed-processes/managed-processes.js";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnedProcess,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { syncFilePublication } from "../../../atomic-file.js";
import { asInternals } from "../../../test-utils/class-mocks.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import * as treeKillUtils from "../../../../utils/tree-kill.js";
import {
  captureProcessTree,
  readLinuxProcessEntry,
  terminateWithTreeKill,
  type ProcessTerminator,
} from "../../../../utils/tree-kill.js";
import { spawnGatedClaudeProcess } from "./process-launch.js";
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
    // for-await returns on the handler error; shutdown also finishes SDK cleanup.
    expect(query.return).toHaveBeenCalledTimes(2);
    handler.mockRestore();
    await expect(session.close()).rejects.toThrow("message processing failed");
    expect(query.return).toHaveBeenCalledTimes(2);
    await expect(session.listCommands()).rejects.toThrow("Claude session is closed");
  });

  test("close waits for a mode change admitted before shutdown", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const query = createQueryMock([]);
    vi.mocked(query.setPermissionMode).mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
    });
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => query,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const modeChanged = session.setMode("plan");
    try {
      await entered.promise;
      const outcome = session.close().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await outcome).toMatchObject({
        message: "Claude session operations did not settle during close",
      });
      finish.resolve();
      await modeChanged;
      await session.close();
      expect(await session.getCurrentMode()).toBe("plan");
    } finally {
      finish.resolve();
      await modeChanged;
      vi.useRealTimers();
      await session.close();
    }
  });

  test("concurrent control operations share one query opening", async () => {
    const entered = Promise.withResolvers<void>();
    const binary = Promise.withResolvers<string>();
    const queryFactory = vi.fn(() => createQueryMock([]));
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => {
        entered.resolve();
        return binary.promise;
      },
      queryFactory,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    try {
      const first = session.listCommands();
      await entered.promise;
      const second = session.listCommands();
      binary.resolve("/test/claude/bin");
      await Promise.all([first, second]);
      expect(queryFactory).toHaveBeenCalledTimes(1);
    } finally {
      binary.resolve("/test/claude/bin");
      await session.close();
    }
  });

  test("close retains an admitted opening and prevents a late provider launch", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const binary = Promise.withResolvers<string>();
    const queryFactory = vi.fn(() => createQueryMock([]));
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => {
        entered.resolve();
        return binary.promise;
      },
      queryFactory,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const commands = session.listCommands().then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      const outcome = session.close().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await outcome).toMatchObject({
        message: "Claude session operations did not settle during close",
      });
      binary.resolve("/test/claude/bin");
      expect(await commands).toMatchObject({ message: "Claude session is closed" });
      await session.close();
      expect(queryFactory).not.toHaveBeenCalled();
    } finally {
      binary.resolve("/test/claude/bin");
      await commands;
      vi.useRealTimers();
      await session.close();
    }
  });

  test("closed sessions refuse mutations that need no live query", async () => {
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => createQueryMock([]),
    }).createSession({ provider: "claude", cwd: process.cwd() });
    await session.close();
    await expect(session.setThinkingOption("high")).rejects.toThrow("Claude session is closed");
    await expect(session.setFeature?.("fast_mode", false)).rejects.toThrow(
      "Claude session is closed",
    );
    await expect(session.revertConversation?.({ messageId: "unseen-message" })).rejects.toThrow(
      "Claude session is closed",
    );
    await expect(
      session.steerActiveTurn?.("late prompt", { expectedTurnId: "retired-turn" }),
    ).rejects.toThrow("Claude session is closed");
    await expect(session.respondToPermission("old-request", { behavior: "allow" })).rejects.toThrow(
      "Claude session is closed",
    );
  });

  test("close waits for the detached rewind turn and delivers its outcome", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const query = createQueryMock([]);
    vi.mocked(query.rewindFiles).mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
      return { canRewind: true };
    });
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => query,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn?.("/rewind 33333333-3333-4333-8333-333333333333");
      await entered.promise;
      const outcome = session.close().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await outcome).toMatchObject({
        message: "Claude session operations did not settle during close",
      });
      finish.resolve();
      await session.close();
      expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed" }));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({ text: expect.stringContaining("Rewound tracked files") }),
        }),
      );
    } finally {
      finish.resolve();
      vi.useRealTimers();
      await session.close();
    }
  });

  test("a reentrant close joins the same operation and interrupt stays idempotent", async () => {
    let reentered: Promise<void> | null = null;
    let firstClose = true;
    const query = createQueryMock([], {
      onClose: () => {
        if (firstClose) {
          firstClose = false;
          reentered = session.close();
        }
      },
    });
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory: () => query,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await session.listCommands();
      const closing = session.close();
      await closing;
      expect(reentered).toBe(closing);
      expect(query.close).toHaveBeenCalledTimes(1);
      await expect(session.interrupt()).resolves.toBeUndefined();
    } finally {
      await session.close();
    }
  });

  test("retiring a query cancels its permissions without waiting for an SDK abort", async () => {
    const queryFactory = vi.fn((_input: ClaudeQueryInput) => createQueryMock([]));
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.listCommands();
      const canUseTool = queryFactory.mock.calls[0][0].options.canUseTool;
      if (!canUseTool) throw new Error("Missing permission callback");
      const permission = canUseTool(
        "Bash",
        { command: "printf test" },
        { signal: new AbortController().signal, toolUseID: "retired-tool" },
      ).catch((error: unknown) => error);
      const [request] = session.getPendingPermissions();
      await session.setThinkingOption(null);
      await session.listCommands();
      expect(await permission).toMatchObject({ message: "Permission request aborted" });
      expect(queryFactory).toHaveBeenCalledTimes(2);
      expect(session.getPendingPermissions()).toEqual([]);
      expect(events.filter((event) => event.type === "permission_resolved")).toEqual([
        expect.objectContaining({
          requestId: request.id,
          resolution: { behavior: "deny", message: "Permission request canceled" },
        }),
      ]);
    } finally {
      await session.close();
    }
  });

  test("permissions arriving while a query stops settle before closure completes", async () => {
    let permissionOutcome: unknown = "pending";
    function recordPermissionOutcome(outcome: unknown): unknown {
      permissionOutcome = outcome;
      return outcome;
    }
    const queryFactory = vi.fn((input: ClaudeQueryInput) =>
      createQueryMock([], {
        onClose: () => {
          const canUseTool = input.options.canUseTool;
          if (!canUseTool) throw new Error("Missing permission callback");
          void canUseTool(
            "Bash",
            { command: "printf test" },
            {
              signal: new AbortController().signal,
              toolUseID: "stopping-tool",
            },
          ).then(recordPermissionOutcome, recordPermissionOutcome);
        },
      }),
    );
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.listCommands();
      await session.close();
      expect(permissionOutcome).toEqual({
        behavior: "deny",
        message: "Claude runtime is closing",
        interrupt: true,
      });
      expect(session.getPendingPermissions()).toEqual([]);
      expect(events.filter((event) => event.type === "permission_requested")).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("callbacks from a retired query cannot change its replacement", async () => {
    const queryFactory = vi.fn((_input: ClaudeQueryInput) => createQueryMock([]));
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
      queryFactory,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    await session.listCommands();
    const hook = queryFactory.mock.calls[0][0].options.hooks?.Stop?.[0]?.hooks[0];
    if (!hook) throw new Error("Missing Stop hook");
    await session.setThinkingOption(null);
    await session.listCommands();
    await expect(
      hook(
        {
          hook_event_name: "Stop",
          session_id: "retired-session",
          transcript_path: "/tmp/session.jsonl",
          cwd: process.cwd(),
          stop_hook_active: false,
          last_assistant_message: "done",
        },
        undefined,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Claude callback arrived after its query was sealed");
    await expect(session.close()).rejects.toThrow(
      "Claude callback arrived after its query was sealed",
    );
    await expect(session.close()).rejects.toThrow(
      "Claude callback arrived after its query was sealed",
    );
    expect(queryFactory).toHaveBeenCalledTimes(2);
    for (const result of queryFactory.mock.results) {
      expect(result.value.close).toHaveBeenCalledTimes(1);
      expect(result.value.return).toHaveBeenCalledTimes(1);
    }
  });

  test.runIf(process.platform !== "win32")(
    "the launch gate preserves PATH lookup and non-shell environment names",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo launch path-"));
      await symlink(process.execPath, path.join(home, "provider-fixture"));
      const launch = spawnGatedClaudeProcess({
        command: "provider-fixture",
        args: [
          "-e",
          `process.stdout.write(JSON.stringify({ cwd: process.cwd(), value: process.env['non-shell-key'] }));`,
        ],
        cwd: home,
        env: { PATH: home, "non-shell-key": 'quoted " value\n' },
      });
      const exited = once(launch.child, "exit");
      const received = once(launch.child.stdout!, "data");
      try {
        await launch.ready;
        const first = launch.start();
        expect(launch.start()).toBe(first);
        await first;
        const [chunk] = await received;
        expect(JSON.parse(String(chunk))).toEqual({
          cwd: await realpath(home),
          value: 'quoted " value\n',
        });
        expect(await exited).toEqual([0, null]);
      } finally {
        launch.child.kill("SIGKILL");
        await exited;
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "the supervised launch preserves provider environment and joins its child",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-supervised-launch-"));
      const marker = path.join(home, "preload-ran");
      const preload = path.join(home, "preload.cjs");
      await writeFile(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`,
      );
      const launch = spawnGatedClaudeProcess({
        strategy: "supervise",
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.once('data', (input) => {
            process.stdout.write(JSON.stringify({ ppid: process.ppid, dylib: process.env.DYLD_LIBRARY_PATH, input: input.toString() }));
            process.stderr.write('provider stderr');
            process.exitCode = 37;
          });`,
        ],
        env: { NODE_OPTIONS: `--require=${preload}`, DYLD_LIBRARY_PATH: home },
      });
      const closed = once(launch.child, "close");
      let output = "";
      let errors = "";
      launch.child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
      launch.child.stderr!.on("data", (chunk: Buffer) => (errors += chunk.toString()));
      try {
        await launch.ready;
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        await launch.start();
        launch.child.stdin!.end("SDK input");
        expect(await closed).toEqual([37, null]);
        expect(JSON.parse(output)).toEqual({
          ppid: launch.child.pid,
          dylib: home,
          input: "SDK input",
        });
        expect(errors).toBe("provider stderr");
        expect(await readFile(marker, "utf8")).toBe("started");
      } finally {
        launch.child.kill("SIGKILL");
        await closed;
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32").each(["SIGTERM", "SIGINT"] as const)(
    "the supervised launch forwards %s and reports the child's signal",
    async (signal) => {
      const launch = spawnGatedClaudeProcess({
        strategy: "supervise",
        command: process.execPath,
        args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        env: {},
      });
      const closed = once(launch.child, "close");
      const received = once(launch.child.stdout!, "data");
      await launch.ready;
      await launch.start();
      await received;
      const tree = await captureProcessTree(launch.child);
      try {
        expect(launch.child.kill(signal)).toBe(true);
        expect(launch.killed).toBe(true);
        expect(await closed).toEqual([null, signal]);
      } finally {
        await terminateWithTreeKill(launch.child, {
          initialTree: tree,
          requireTreeProof: true,
          gracefulTimeoutMs: 1_000,
          forceTimeoutMs: 1_000,
        });
        await closed;
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "a fresh registry stops a supervised provider from its durable launch root",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-supervised-recovery-"));
      const marker = path.join(home, "provider-stopped");
      const registryOptions = {
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      };
      const registry = createManagedProcessRegistry(registryOptions);
      const launch = spawnGatedClaudeProcess({
        strategy: "supervise",
        command: process.execPath,
        args: [
          "-e",
          `process.once('SIGTERM', () => {
            require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'stopped');
            process.exit(0);
          }); process.stdout.write('ready'); setInterval(() => {}, 1000);`,
        ],
        env: {},
      });
      const closed = once(launch.child, "close");
      const received = once(launch.child.stdout!, "data");
      await launch.ready;
      const tree = await captureProcessTree(launch.child);
      try {
        await registry.record({
          owner: { provider: "claude", kind: "query" },
          pid: launch.child.pid!,
          command: process.execPath,
          args: [],
          processTree: tree,
        });
        await launch.start();
        await received;
        const recovered = createManagedProcessRegistry(registryOptions);
        expect(await recovered.reapStale()).toEqual({
          checked: 1,
          dead: 0,
          mismatched: 0,
          removed: 1,
          terminated: 1,
          errors: [],
        });
        await closed;
        expect(await readFile(marker, "utf8")).toBe("stopped");
        expect(await recovered.list()).toEqual([]);
      } finally {
        await terminateWithTreeKill(launch.child, {
          initialTree: tree,
          requireTreeProof: true,
          gracefulTimeoutMs: 1_000,
          forceTimeoutMs: 1_000,
        });
        await closed;
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "the supervised launch reports a missing executable without hanging",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-supervised-missing-"));
      const launch = spawnGatedClaudeProcess({
        strategy: "supervise",
        command: path.join(home, "missing-provider"),
        args: ["private-argument"],
        env: {},
      });
      const closed = once(launch.child, "close");
      let errors = "";
      launch.child.stderr!.on("data", (chunk: Buffer) => (errors += chunk.toString()));
      try {
        await launch.ready;
        await launch.start();
        expect(await closed).toEqual([1, null]);
        expect(errors).toBe("Claude process launch failed before exec\n");
      } finally {
        launch.child.kill("SIGKILL");
        await closed;
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "tree shutdown forcibly stops an unresponsive supervised provider",
    async () => {
      const launch = spawnGatedClaudeProcess({
        strategy: "supervise",
        command: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
        ],
        env: {},
      });
      const closed = once(launch.child, "close");
      const received = once(launch.child.stdout!, "data");
      try {
        await launch.ready;
        await launch.start();
        await received;
        expect(
          await terminateWithTreeKill(launch.child, {
            requireTreeProof: true,
            gracefulTimeoutMs: 50,
            forceTimeoutMs: 1_000,
          }),
        ).toBe("killed");
        expect(await closed).toEqual([null, "SIGKILL"]);
      } finally {
        await terminateWithTreeKill(launch.child, {
          requireTreeProof: true,
          gracefulTimeoutMs: 50,
          forceTimeoutMs: 1_000,
        });
        await closed;
      }
    },
  );

  test.runIf(process.platform !== "win32").each([
    { strategy: "replace" as const, lookup: "absolute" },
    { strategy: "supervise" as const, lookup: "absolute" },
    { strategy: "supervise" as const, lookup: "PATH" },
  ])(
    "the $strategy launch gate preserves a script without a shebang via $lookup",
    async ({ strategy, lookup }) => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo launch script-"));
      const script = path.join(home, "provider-fixture");
      await writeFile(script, "printf '%s' \"$1\"", { mode: 0o700 });
      const shadow = path.join(home, "shadow");
      await mkdir(shadow);
      await writeFile(path.join(shadow, "provider-fixture"), "exit 42", { mode: 0o700 });
      const launch = spawnGatedClaudeProcess({
        strategy,
        cwd: shadow,
        command: lookup === "PATH" ? path.basename(script) : script,
        args: ['quoted " argument; $(exit 42)'],
        env: { PATH: home },
      });
      const exited = once(launch.child, "close");
      let output = "";
      launch.child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
      try {
        await launch.ready;
        await launch.start();
        expect(await exited).toEqual([0, null]);
        expect(output).toBe('quoted " argument; $(exit 42)');
      } finally {
        launch.child.kill("SIGKILL");
        await exited;
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform === "linux").each(["empty", "partial"])(
    "provider cannot start after its parent dies with a %s launch packet",
    async (packetKind) => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-launch-parent-death-"));
      const marker = path.join(home, "provider-started");
      const launcherUrl = new URL("./process-launch.ts", import.meta.url).href;
      const targetArgs = [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`,
      ];
      const fragment =
        packetKind === "partial"
          ? JSON.stringify({ command: process.execPath, args: targetArgs, env: {} }).slice(0, -1)
          : "";
      const parent = spawnUtils.spawnProcess(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--input-type=module",
          "-e",
          `
        const { spawnGatedClaudeProcess } = await import(${JSON.stringify(launcherUrl)});
        const launch = spawnGatedClaudeProcess({ command: ${JSON.stringify(process.execPath)}, args: ${JSON.stringify(targetArgs)}, env: {} });
        await launch.ready;
        const fragment = ${JSON.stringify(fragment)};
        if (fragment) await new Promise((resolve, reject) => launch.child.stdio[3].write(fragment, (error) => error ? reject(error) : resolve()));
        process.stdout.write(String(launch.child.pid));
        setInterval(() => {}, 1000);
      `,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = once(parent, "exit");
      let gatePid: number | null = null;
      let gateBirth: string | null = null;
      try {
        const [pid] = await Promise.race([
          once(parent.stdout!, "data"),
          exited.then(() => {
            throw new Error("Fixture parent exited before reporting its gate");
          }),
        ]);
        gatePid = Number(String(pid));
        gateBirth = (await readLinuxProcessEntry(gatePid))!.startedAt;
        parent.kill("SIGKILL");
        await exited;
        await expect
          .poll(async () => {
            const entry = await readLinuxProcessEntry(gatePid!);
            return entry === null || entry.exited || entry.startedAt !== gateBirth;
          })
          .toBe(true);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        parent.kill("SIGKILL");
        await exited;
        const entry = gatePid ? await readLinuxProcessEntry(gatePid) : null;
        if (entry && !entry.exited && entry.startedAt === gateBirth)
          process.kill(entry.pid, "SIGKILL");
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "closing during durable launch admission never dispatches the provider",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-launch-admission-"));
      const marker = path.join(home, "provider-started");
      const observed = Promise.withResolvers<"admission" | "provider">();
      const publication = Promise.withResolvers<void>();
      let writes = 0;
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        syncPublication: async (file, root) => {
          if (++writes === 2) {
            observed.resolve("admission");
            await publication.promise;
          }
          await syncFilePublication(file, root);
        },
      });
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory: ({ options }) => {
          if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
          const child = options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.stdout.write('started'); setInterval(() => {}, 1000)`,
            ],
            cwd: process.cwd(),
            env: {},
            signal: new AbortController().signal,
          });
          child.stdout.once("data", () => observed.resolve("provider"));
          return createQueryMock([]);
        },
      }).createSession({ provider: "claude", cwd: process.cwd() });
      const opening = session.listCommands();
      void opening.catch(() => {});
      try {
        expect(await observed.promise).toBe("admission");
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        const closing = session.close();
        publication.resolve();
        await expect(opening).rejects.toThrow("closed before process launch");
        await closing;
        expect(await registry.list()).toEqual([]);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        publication.resolve();
        await opening.catch(() => {});
        await session.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "failed launch admission cannot execute the provider and closure retries its publication",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-launch-admission-failure-"));
      const marker = path.join(home, "provider-started");
      let writes = 0;
      let failAdmission = true;
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        syncPublication: async (file, root) => {
          if (++writes > 1 && failAdmission) throw new Error("Launch admission sync failed");
          await syncFilePublication(file, root);
        },
      });
      const query = createQueryMock([]);
      const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
        if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
        options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`,
          ],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        });
        return query;
      });
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory,
      }).createSession({ provider: "claude", cwd: process.cwd() });
      try {
        await expect(session.listCommands()).rejects.toThrow("Launch admission sync failed");
        await expect(session.close()).rejects.toThrow("Launch admission sync failed");
        expect(await registry.list()).toHaveLength(1);
        expect(query.supportedCommands).not.toHaveBeenCalled();
        failAdmission = false;
        await session.close();
        expect(await registry.list()).toEqual([]);
        expect(queryFactory).toHaveBeenCalledTimes(1);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        failAdmission = false;
        await session.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32").each(["durable", "failed"] as const)(
    "a bootstrap exit during %s registration remains closeable",
    async (publicationResult) => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-bootstrap-registration-exit-"));
      const entered = Promise.withResolvers<void>();
      const publication = Promise.withResolvers<void>();
      let writes = 0;
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        syncPublication: async (file, root) => {
          if (++writes === 1) {
            entered.resolve();
            await publication.promise;
            if (publicationResult === "failed") throw new Error("Registration sync failed");
          }
          await syncFilePublication(file, root);
        },
      });
      const children: SpawnedProcess[] = [];
      const exited = Promise.withResolvers<void>();
      const query = createQueryMock([]);
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory: ({ options }) => {
          if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
          const child = options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: ["-e", "throw new Error('Provider must not run')"],
            cwd: process.cwd(),
            env: {},
            signal: new AbortController().signal,
          });
          children.push(child);
          child.on("exit", exited.resolve.bind(undefined, undefined));
          return query;
        },
      }).createSession({ provider: "claude", cwd: process.cwd() });
      const opening = session.listCommands();
      void opening.catch(() => {});
      try {
        await entered.promise;
        children[0]!.kill("SIGKILL");
        await exited.promise;
        publication.resolve();
        await expect(opening).rejects.toThrow(
          publicationResult === "failed"
            ? "registration is not durable"
            : "bootstrap exited before process launch",
        );
        await session.close();
        expect(await registry.list()).toEqual([]);
        expect(query.supportedCommands).not.toHaveBeenCalled();
        expect(query.close).toHaveBeenCalledTimes(1);
      } finally {
        publication.resolve();
        await opening.catch(() => {});
        for (const child of children) child.kill("SIGKILL");
        await exited.promise;
        await session.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "closing during registration never releases the provider launch gate",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-launch-cancel-"));
      const marker = path.join(home, "provider-started");
      const entered = Promise.withResolvers<void>();
      const publication = Promise.withResolvers<void>();
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        syncPublication: async (file, root) => {
          entered.resolve();
          await publication.promise;
          await syncFilePublication(file, root);
        },
      });
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory: ({ options }) => {
          if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
          options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`,
            ],
            cwd: process.cwd(),
            env: {},
            signal: new AbortController().signal,
          });
          return createQueryMock([]);
        },
      }).createSession({ provider: "claude", cwd: process.cwd() });
      const opening = session.listCommands();
      void opening.catch(() => {});
      try {
        await entered.promise;
        const closing = session.close();
        publication.resolve();
        await expect(opening).rejects.toThrow("closed before process launch");
        await closing;
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await registry.list()).toEqual([]);
      } finally {
        publication.resolve();
        await opening.catch(() => {});
        await session.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform === "linux")(
    "waits for durable registration before executing provider code and preserves exec identity and streams",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-launch-gate-"));
      const marker = path.join(home, "preload-ran");
      const preload = path.join(home, "preload.cjs");
      await writeFile(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`,
      );
      const entered = Promise.withResolvers<void>();
      const allowPublication = Promise.withResolvers<void>();
      let firstPublication = true;
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        syncPublication: async (file, root) => {
          if (firstPublication) {
            firstPublication = false;
            entered.resolve();
            await allowPublication.promise;
          }
          await syncFilePublication(file, root);
        },
      });
      const spawn = vi.spyOn(spawnUtils, "spawnProcess");
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory: ({ options }) => {
          if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
          options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: [
              "-e",
              `
            process.stdin.once('data', (input) => {
              process.stdout.write(JSON.stringify({ pid: process.pid, argument: process.argv[1], value: process.env.PASEO_GATE_TEST_VALUE, input: input.toString() }));
            });
            setInterval(() => {}, 1000);
          `,
              "--",
              "provider-argument-secret",
            ],
            cwd: process.cwd(),
            env: {
              NODE_OPTIONS: `--require=${preload}`,
              PASEO_GATE_TEST_VALUE: 'value with quotes " and newline\n',
            },
            signal: new AbortController().signal,
          });
          return createQueryMock([]);
        },
      }).createSession({ provider: "claude", cwd: process.cwd() });
      const opening = session.listCommands();
      void opening.catch(() => {});
      try {
        await entered.promise;
        const child = spawn.mock.results[0]!.value;
        const commandLine = await readFile(`/proc/${child.pid}/cmdline`, "utf8");
        expect(commandLine.includes("provider-argument-secret")).toBe(false);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        const [record] = await registry.list();
        const received = once(child.stdout!, "data");
        allowPublication.resolve();
        await opening;
        child.stdin!.write("SDK input");
        const [chunk] = await received;
        expect(JSON.parse(String(chunk))).toEqual({
          pid: record!.pid,
          argument: "provider-argument-secret",
          value: 'value with quotes " and newline\n',
          input: "SDK input",
        });
        expect(await readFile(marker, "utf8")).toBe("started");
        await session.close();
        expect(await registry.list()).toEqual([]);
      } finally {
        allowPublication.resolve();
        await opening.catch(() => {});
        await session.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "a throwing SDK constructor cannot leave a registered process or start its provider",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-query-construction-"));
      const marker = path.join(home, "provider-started");
      const published = Promise.withResolvers<void>();
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        syncPublication: async (file, root) => {
          await syncFilePublication(file, root);
          published.resolve();
        },
      });
      const children: SpawnedProcess[] = [];
      const exited = Promise.withResolvers<void>();
      const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
        if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
        const child = options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`,
          ],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        });
        children.push(child);
        child.on("exit", exited.resolve.bind(undefined, undefined));
        throw new Error("SDK construction failed after spawning");
      });
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory,
      }).createSession({ provider: "claude", cwd: process.cwd() });
      try {
        await expect(session.listCommands()).rejects.toThrow("SDK construction failed");
        await published.promise;
        await session.close();
        expect(await registry.list()).toEqual([]);
        await exited.promise;
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(queryFactory).toHaveBeenCalledTimes(1);
      } finally {
        await registry.reapStale();
        for (const child of children) child.kill("SIGKILL");
        await exited.promise;
        await session.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "failed construction retains cleanup and blocks a replacement until storage recovers",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-query-cleanup-retry-"));
      const marker = path.join(home, "failed-provider-started");
      let publicationCount = 0;
      let blockCleanup = true;
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        syncPublication: async (file, root) => {
          publicationCount += 1;
          if (blockCleanup && publicationCount > 1) throw new Error("Closure sync unavailable");
          await syncFilePublication(file, root);
        },
      });
      const children: SpawnedProcess[] = [];
      const exits: Promise<void>[] = [];
      let constructionCount = 0;
      const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
        if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
        constructionCount += 1;
        const child = options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: [
            "-e",
            `if (${constructionCount} === 1) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`,
          ],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        });
        children.push(child);
        const exited = Promise.withResolvers<void>();
        exits.push(exited.promise);
        child.on("exit", exited.resolve.bind(undefined, undefined));
        if (constructionCount === 1) throw new Error("SDK construction failed after spawning");
        return createQueryMock([]);
      });
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory,
      }).createSession({ provider: "claude", cwd: process.cwd() });
      try {
        await expect(session.listCommands()).rejects.toThrow("SDK construction failed");
        await expect(session.listCommands()).rejects.toThrow("Closure sync unavailable");
        expect(queryFactory).toHaveBeenCalledTimes(1);
        expect(await registry.list()).toHaveLength(1);
        blockCleanup = false;
        expect((await session.listCommands()).map((command) => command.name)).toEqual(["rewind"]);
        await exits[0];
        expect(queryFactory).toHaveBeenCalledTimes(2);
        expect(await registry.list()).toHaveLength(1);
        await session.close();
        expect(await registry.list()).toEqual([]);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        blockCleanup = false;
        await session.close();
        await registry.reapStale();
        for (const child of children) child.kill("SIGKILL");
        await Promise.all(exits);
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "a bootstrap spawn failure closes without inventing a process record",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-bootstrap-spawn-failure-"));
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      });
      const query = createQueryMock([]);
      const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
        if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
        options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: ["-e", "throw new Error('Provider must not run')"],
          cwd: path.join(home, "missing-directory"),
          env: {},
          signal: new AbortController().signal,
        });
        return query;
      });
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory,
      }).createSession({ provider: "claude", cwd: process.cwd() });
      try {
        await expect(session.listCommands()).rejects.toThrow("ENOENT");
        await session.close();
        expect(await registry.list()).toEqual([]);
        expect(queryFactory).toHaveBeenCalledTimes(1);
        expect(query.supportedCommands).not.toHaveBeenCalled();
        expect(query.close).toHaveBeenCalledTimes(1);
      } finally {
        await session.close().catch(() => {});
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "failed initial inspection stops the unused bootstrap without requiring inspection recovery",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-query-inspection-retry-"));
      const marker = path.join(home, "provider-started");
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      });
      const capture = vi
        .spyOn(treeKillUtils, "captureProcessTree")
        .mockRejectedValue(new Error("Process inspection unavailable"));
      const children: SpawnedProcess[] = [];
      const exited = Promise.withResolvers<void>();
      const query = createQueryMock([]);
      const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
        if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
        const child = options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`,
          ],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        });
        children.push(child);
        child.on("exit", exited.resolve.bind(undefined, undefined));
        return query;
      });
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory,
      }).createSession({ provider: "claude", cwd: process.cwd() });
      try {
        await expect(session.listCommands()).rejects.toThrow("Process inspection unavailable");
        await expect(session.listCommands()).rejects.toThrow("Process inspection unavailable");
        await session.close();
        await exited.promise;
        expect(await registry.list()).toEqual([]);
        expect(query.supportedCommands).not.toHaveBeenCalled();
        expect(query.close).toHaveBeenCalledTimes(1);
        expect(queryFactory).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledTimes(1);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await session.close().catch(() => {});
        await registry.reapStale();
        for (const child of children) child.kill("SIGKILL");
        await exited.promise;
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "an unused bootstrap still requires confirmed exit before query cleanup",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-bootstrap-stop-retry-"));
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      });
      vi.spyOn(treeKillUtils, "captureProcessTree").mockRejectedValue(
        new Error("Inspection unavailable"),
      );
      const spawn = vi.spyOn(spawnUtils, "spawnProcess");
      const query = createQueryMock([]);
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory: ({ options }) => {
          if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
          options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            cwd: process.cwd(),
            env: {},
            signal: new AbortController().signal,
          });
          return query;
        },
      }).createSession({ provider: "claude", cwd: process.cwd() });
      await expect(session.listCommands()).rejects.toThrow("Inspection unavailable");
      const child = spawn.mock.results[0]!.value;
      const exited = once(child, "close");
      const kill = vi.spyOn(child, "kill").mockReturnValueOnce(false);
      try {
        await expect(session.close()).rejects.toThrow("bootstrap did not finish closing");
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(query.close).not.toHaveBeenCalled();
        await session.close();
        await exited;
        expect(query.close).toHaveBeenCalledTimes(1);
        expect(await registry.list()).toEqual([]);
      } finally {
        kill.mockRestore();
        child.kill("SIGKILL");
        await exited;
        await session.close().catch(() => {});
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "retries failed process registration during close without launching another query",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-claude-registration-retry-"));
      const blocker = path.join(home, "runtime");
      await writeFile(blocker, "prevents ledger publication");
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      });
      const query = createQueryMock([]);
      let fixtureChild: ChildProcess | null = null;
      let exited = Promise.resolve();
      const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
        if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
        const child = options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        });
        // The production spawn helper owns the real Node child behind this SDK interface.
        const completion = Promise.withResolvers<void>();
        exited = completion.promise;
        child.on("exit", completion.resolve.bind(undefined, undefined));
        return query;
      });
      const spawn = vi.spyOn(spawnUtils, "spawnProcess");
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory,
      }).createSession({ provider: "claude", cwd: process.cwd() });
      try {
        await expect(session.listCommands()).rejects.toThrow("registration is not durable");
        fixtureChild = spawn.mock.results[0]!.value;
        await expect(session.listCommands()).rejects.toThrow("registration is not durable");
        await expect(session.close()).rejects.toThrow();
        expect(query.supportedCommands).not.toHaveBeenCalled();
        expect(query.close).not.toHaveBeenCalled();
        expect(queryFactory).toHaveBeenCalledTimes(1);
        expect(fixtureChild!.exitCode).toBeNull();
        await rm(blocker);
        vi.mocked(query.return!).mockRejectedValueOnce(new Error("Query return failed"));
        await expect(session.close()).rejects.toThrow("Query return failed");
        await exited;
        expect(await registry.list()).toEqual([]);
        await session.close();
        expect(await registry.list()).toEqual([]);
        expect(queryFactory).toHaveBeenCalledTimes(1);
        expect(query.close).toHaveBeenCalledTimes(1);
        expect(query.return).toHaveBeenCalledTimes(2);
      } finally {
        fixtureChild?.kill("SIGKILL");
        await exited;
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "registers a real Claude process durably and removes it only after shutdown",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-claude-ledger-"));
      const registry = createManagedProcessRegistry({
        paseoHome: home,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      });
      const query = createQueryMock([]);
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
        managedProcesses: registry,
        queryFactory: ({ options }) => {
          if (!options.spawnClaudeCodeProcess) throw new Error("Missing launcher");
          options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)", "inline-secret-must-not-be-recorded"],
            cwd: process.cwd(),
            env: {},
            signal: new AbortController().signal,
          });
          return query;
        },
      }).createSession({ provider: "claude", cwd: process.cwd() }, { agentId: "ledger-agent" });
      try {
        await session.listCommands();
        const records = await registry.list();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          owner: { provider: "claude", kind: "query" },
          metadata: { agentId: "ledger-agent", cwd: process.cwd() },
          tree: { inspectionPending: false, checkpoint: { bootId: expect.any(String) } },
          args: [],
          identity: { commandLine: null, startedAt: null },
        });
        const file = await readFile(
          path.join(home, "runtime", "managed-processes", `${records[0]!.id}.json`),
          "utf8",
        );
        expect(file).not.toContain("inline-secret-must-not-be-recorded");
        await session.close();
        expect(await registry.list()).toEqual([]);
        expect(query.close).toHaveBeenCalledTimes(1);
      } finally {
        await session.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test("retains a runtime whose exit is uncertain and retries cleanup before closing its query", async () => {
    const query = createQueryMock([]);
    let stopped = 0;
    let childExit = Promise.resolve();
    let attempts = 0;
    const processTerminator: ProcessTerminator = async (child, options) => {
      expect(options.requireTreeProof).toBe(process.platform !== "win32");
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

  test.skipIf(process.platform === "win32")(
    "an unexpected root exit cannot certify query closure",
    async () => {
      const query = createQueryMock([]);
      let stop = () => {};
      let exited = Promise.resolve();
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => process.execPath,
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
          stop = () => {
            child.kill("SIGKILL");
          };
          exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
          return query;
        },
      }).createSession({ provider: "claude", cwd: process.cwd() });
      try {
        await session.listCommands();
        stop();
        await exited;
        await expect(session.close()).rejects.toThrow("Claude process tree exit is unconfirmed");
        await expect(session.close()).rejects.toThrow("Claude process tree exit is unconfirmed");
        expect(query.close).not.toHaveBeenCalled();
        expect(query.return).not.toHaveBeenCalled();
      } finally {
        stop();
        await exited;
      }
    },
  );

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
      processTerminator: async () => "already-exited",
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
