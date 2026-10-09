import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../../utils/tree-kill.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
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
