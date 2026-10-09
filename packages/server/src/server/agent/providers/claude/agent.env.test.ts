import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentLaunchContext } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";
import { claudeConfigDir, claudeProjectDirSync } from "./project-dir.js";

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

describe("Claude SDK env", () => {
  test.each(["2.1.296", undefined, "unknown"])(
    "refreshes resumed runtime provenance from init version %s without changing credential lookup",
    async (version) => {
      const sessionId = randomUUID();
      const home = mkdtempSync(path.join(tmpdir(), "claude-runtime-resume-"));
      vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
      const env = { HOME: home, USERPROFILE: home };
      const configDir = claudeConfigDir(env);
      const project = path.join(configDir, "projects", "paseo-handoff-test");
      mkdirSync(project, { recursive: true });
      writeFileSync(path.join(project, `${sessionId}.jsonl`), "");
      const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
        expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(options.env?.CLAUDE_CODE_PROJECT_DIR_NAME).toBe("paseo-handoff-test");
        return createQueryMock([
          {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            claude_code_version: version,
            permissionMode: "default",
            model: "opus",
          },
          {
            type: "result",
            subtype: "success",
            usage: { input_tokens: 1, output_tokens: 1 },
            total_cost_usd: 0,
          },
        ]);
      });
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        queryFactory,
        runtimeSettings: { env },
        resolveBinary: async () => "/test/claude/bin",
      });
      const session = await client.resumeSession({
        provider: "claude",
        sessionId,
        metadata: {
          cwd: process.cwd(),
          claudeProjectDirName: "paseo-handoff-test",
          claudeRuntime: { configDir, cliVersion: "2.1.295" },
        },
      });
      try {
        await session.run("continue");
        const handle = session.describePersistence();
        if (!handle) throw new Error("Missing resumed persistence");
        expect(handle.sessionId).toBe(sessionId);
        expect(handle.metadata?.claudeRuntime).toEqual(
          version === "2.1.296" ? { configDir, cliVersion: version } : undefined,
        );
      } finally {
        await session.close();
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test("retains the observed session runtime for handoff after provider configuration changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-runtime-handoff-"));
    const originalHome = path.join(root, "original");
    const changedHome = path.join(root, "changed");
    const sessionId = randomUUID();
    const settings = {
      env: {
        CLAUDE_CONFIG_DIR: path.join(root, "default"),
        ANTHROPIC_API_KEY: "PRIVATE_CREDENTIAL",
      },
    };
    const launch = { env: { CLAUDE_CONFIG_DIR: originalHome } };
    const queryFactory = vi.fn(() =>
      createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          claude_code_version: "2.1.295",
          permissionMode: "default",
          model: "opus",
        },
        { type: "assistant", message: { content: "done" } },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]),
    );
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: settings,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({ provider: "claude", cwd: root }, launch);
    try {
      settings.env.CLAUDE_CONFIG_DIR = changedHome;
      launch.env.CLAUDE_CONFIG_DIR = changedHome;
      await session.run("capture runtime");
      const handle = session.describePersistence();
      if (!handle) throw new Error("Missing native persistence");
      expect(handle.metadata?.claudeRuntime).toEqual({
        configDir: originalHome,
        cliVersion: "2.1.295",
      });
      expect(JSON.stringify(handle.metadata?.claudeRuntime)).not.toContain("PRIVATE_CREDENTIAL");
      await session.close();
      const project = claudeProjectDirSync(root, { configDir: originalHome });
      mkdirSync(project, { recursive: true });
      writeFileSync(
        path.join(project, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: randomUUID(),
          sessionId,
          message: { role: "user", content: "original home history" },
        }) + "\n",
      );
      const changedFactory = vi.fn(() => {
        throw new Error("Must not launch in another home");
      });
      const changedClient = new ClaudeAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { env: { CLAUDE_CONFIG_DIR: changedHome } },
        queryFactory: changedFactory,
        resolveBinary: async () => "/test/claude/bin",
      });
      const resumed = await changedClient.resumeSession(handle, { cwd: root });
      try {
        const events = [];
        for await (const event of resumed.streamHistory()) events.push(event);
        expect(JSON.stringify(events)).toContain("original home history");
        await expect(resumed.run("continue")).rejects.toThrow("Claude session storage changed");
        expect(changedFactory).not.toHaveBeenCalled();
        expect(resumed.describePersistence()?.metadata?.claudeRuntime).toEqual(
          handle.metadata?.claudeRuntime,
        );
      } finally {
        await resumed.close();
      }
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forwards launch-context env through Claude process env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    let capturedPerTaskStopAffordance: boolean | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000201",
        PASEO_TEST_FLAG: "launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      capturedPerTaskStopAffordance = options.perTaskStopAffordance;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "managed-agent-env-session",
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

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      runtimeSettings: {
        env: {
          MCP_TIMEOUT: "claude-startup-timeout",
          MCP_TOOL_TIMEOUT: "claude-tool-timeout",
        },
      },
    });
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const result = await session.run("env check");
      expect(result.sessionId).toBe("managed-agent-env-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
      expect(capturedEnv?.MCP_TIMEOUT).toBe("claude-startup-timeout");
      expect(capturedEnv?.MCP_TOOL_TIMEOUT).toBe("claude-tool-timeout");
      expect(session.usageSession?.()?.env).toBe(capturedEnv);
      // Paseo reads session_state_changed to know when an autonomous turn is over.
      expect(capturedEnv?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
      // Without it, Stop and replace kill every background subagent along with the turn.
      expect(capturedPerTaskStopAffordance).toBe(true);
    } finally {
      await session.close();
      expect(session.usageSession?.()).toBeNull();
    }
  });

  test("forwards launch-context env through Claude resume env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000202",
        PASEO_TEST_FLAG: "resume-launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "persisted-session",
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

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "persisted-session",
        metadata: {
          cwd: process.cwd(),
        },
      },
      {
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const descriptor = session.usageSession?.();
      expect(descriptor?.env.PASEO_TEST_FLAG).toBe("resume-launch-value");
      expect(descriptor?.sessionKey).toEqual(expect.any(String));
      expect(queryFactory).not.toHaveBeenCalled();
      const result = await session.run("resume env check");
      expect(session.usageSession?.()?.sessionKey).toBe(descriptor?.sessionKey);
      expect(capturedEnv).toBe(descriptor?.env);
      expect(result.sessionId).toBe("persisted-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
    } finally {
      await session.close();
      expect(session.usageSession?.()).toBeNull();
    }
  });
});
