import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import {
  createFrameFeed,
  createScriptedQueryFactory,
  initFrame,
} from "./test-utils/scripted-query.js";

test("a reserved session id binds a fresh query instead of resuming a transcript", async () => {
  const feed = createFrameFeed();
  const query = createScriptedQueryFactory(feed);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: query.queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });

  const session = await client.createSession(
    { provider: "claude", cwd: process.cwd() },
    undefined,
    { reservedSessionId: "11111111-2222-4333-8444-555555555555" },
  );
  expect(session.id).toBe("11111111-2222-4333-8444-555555555555");

  await session.startTurn("hello");
  feed.push(initFrame());
  await feed.drained();

  const launch = vi.mocked(query.queryFactory).mock.calls[0]?.[0] as {
    options: { sessionId?: string; resume?: string };
  };
  expect(launch.options.sessionId).toBe("11111111-2222-4333-8444-555555555555");
  expect(launch.options.resume).toBeUndefined();
  await session.close();
});
