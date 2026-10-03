import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";

function buildQueryMock(events: unknown[]) {
  let index = 0;
  return {
    next: vi.fn(async () => {
      // A live CLI keeps its stream open between turns; ending it would tear the runtime down.
      if (index >= events.length) return new Promise<never>(() => undefined);
      const value = events[index];
      index += 1;
      return { done: false, value };
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    stopTask: vi.fn(async () => undefined),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

const BACKGROUND_TASKS_STREAM = [
  { type: "system", subtype: "init", session_id: "bg-tasks-session", permissionMode: "default" },
  {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      { task_id: "bash-1", task_type: "local_bash", description: "Watch canary run" },
      { task_id: "agent-1", task_type: "local_agent", description: "Review the diff" },
    ],
  },
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
  },
];

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "turn_completed" || event.type === "turn_failed") {
      break;
    }
  }
  return events;
}

describe("Claude background tasks", () => {
  test("reports live shell tasks, leaves subagents to the subagents track, and stops by id", async () => {
    const query = buildQueryMock(BACKGROUND_TASKS_STREAM);
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: vi.fn(() => query),
      resolveBinary: async () => "/test/claude/bin",
    }).createSession({ provider: "claude", cwd: process.cwd() });

    const events = await collectUntilTerminal(streamSession(session, "watch the deploy"));
    const changes = events.filter((event) => event.type === "background_tasks_changed");

    expect(changes).toMatchObject([
      {
        type: "background_tasks_changed",
        provider: "claude",
        tasks: [
          {
            id: "bash-1",
            taskType: "local_bash",
            description: "Watch canary run",
            startedAt: expect.any(String),
          },
        ],
      },
    ]);

    await session.stopBackgroundTask?.("bash-1");
    expect(query.stopTask).toHaveBeenCalledWith("bash-1");
    await session.close();
  });
});
