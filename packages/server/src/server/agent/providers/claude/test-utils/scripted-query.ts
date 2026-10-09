import type { Logger } from "pino";
import { vi } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "../agent.js";

export type SdkFrame = Record<string, unknown>;

/** Hands frames to the query pump one at a time and reports when the pump asks for the next one. */
export function createFrameFeed() {
  const frames: Array<SdkFrame | null> = [];
  let wakePump: (() => void) | null = null;
  let nextRequested: (() => void) | null = null;
  return {
    push(frame: SdkFrame): void {
      frames.push(frame);
      wakePump?.();
    },
    end(): void {
      frames.push(null);
      wakePump?.();
    },
    /** Resolves once the pump has consumed everything pushed so far and is waiting again. */
    drained(): Promise<void> {
      return new Promise<void>((resolve) => {
        nextRequested = resolve;
      });
    },
    async next(): Promise<IteratorResult<SdkFrame, void>> {
      if (frames.length === 0) {
        nextRequested?.();
        nextRequested = null;
        await new Promise<void>((resolve) => {
          wakePump = resolve;
        });
        wakePump = null;
      }
      const frame = frames.shift();
      return frame ? { done: false, value: frame } : { done: true, value: undefined };
    },
  };
}

export type FrameFeed = ReturnType<typeof createFrameFeed>;

export interface ScriptedQueryBehavior {
  cancelAsyncMessage?: (uuid: string) => Promise<boolean>;
  failToStart?: Error;
}

/** A query factory port whose stream is the feed and whose prompt pushes are recorded. */
export function createScriptedQueryFactory(feed: FrameFeed, behavior: ScriptedQueryBehavior = {}) {
  const promptUuids: string[] = [];
  const cancelled: string[] = [];
  const queryFactory = vi.fn();
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    if (behavior.failToStart) {
      throw behavior.failToStart;
    }
    void (async () => {
      for await (const message of prompt) {
        const uuid = (message as { uuid?: unknown }).uuid;
        if (typeof uuid === "string") promptUuids.push(uuid);
      }
    })();
    return {
      next: () => feed.next(),
      interrupt: async () => undefined,
      return: async () => undefined,
      close: () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      getContextUsage: async () => undefined,
      supportedModels: async () => [{ value: "opus", displayName: "Opus" }],
      supportedCommands: async () => [],
      rewindFiles: async () => ({ canRewind: true }),
      cancelAsyncMessage: async (uuid: string) => {
        cancelled.push(uuid);
        return behavior.cancelAsyncMessage ? behavior.cancelAsyncMessage(uuid) : false;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  });
  return {
    queryFactory,
    submittedUuid: () => {
      const uuid = promptUuids[0];
      if (!uuid) throw new Error("the adapter has not pushed a prompt yet");
      return uuid;
    },
    cancelled,
  };
}

export async function createScriptedClaudeSession(
  feed: FrameFeed,
  behavior: ScriptedQueryBehavior = {},
  logger: Logger = createTestLogger(),
) {
  const query = createScriptedQueryFactory(feed, behavior);
  const client = new ClaudeAgentClient({
    logger,
    queryFactory: query.queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  return { session, query };
}

export function initFrame(): SdkFrame {
  return {
    type: "system",
    subtype: "init",
    session_id: "scripted-session",
    permissionMode: "default",
    model: "opus",
  };
}

export function lifecycleFrame(uuid: string, state: string): SdkFrame {
  return { type: "command_lifecycle", command_uuid: uuid, state };
}

export function userReplayFrame(uuid: string): SdkFrame {
  return {
    type: "user",
    message: { role: "user", content: "prompt replay" },
    parent_tool_use_id: null,
    uuid,
    session_id: "scripted-session",
  };
}

export function resultFrame(): SdkFrame {
  return {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
  };
}
