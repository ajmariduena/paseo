import { expect, test } from "vitest";

import {
  readTurnSubmissionOutcome,
  type AgentStreamEvent,
  type AgentSubmissionOutcome,
} from "../../agent-sdk-types.js";
import {
  createFrameFeed,
  createScriptedClaudeSession,
  initFrame,
  lifecycleFrame,
  resultFrame,
  userReplayFrame,
} from "./test-utils/scripted-query.js";

function outcomeNow(
  submission: Promise<AgentSubmissionOutcome>,
): Promise<AgentSubmissionOutcome | "pending"> {
  return Promise.race([submission, Promise.resolve<"pending">("pending")]);
}

test("local start resolves first; acceptance waits for the submitted uuid's lifecycle frame", async () => {
  const feed = createFrameFeed();
  const { session, query } = await createScriptedClaudeSession(feed);

  const started = await session.startTurn("hello");
  if (!started.submission) throw new Error("Claude must expose a submission outcome");
  expect(started.turnId).toMatch(/.+/);
  expect(await outcomeNow(started.submission)).toBe("pending");

  feed.push(initFrame());
  await feed.drained();
  expect(await outcomeNow(started.submission)).toBe("pending");

  feed.push(lifecycleFrame("some-other-steer", "started"));
  await feed.drained();
  expect(await outcomeNow(started.submission)).toBe("pending");

  feed.push(lifecycleFrame(query.submittedUuid(), "queued"));
  await feed.drained();
  expect(await outcomeNow(started.submission)).toBe("pending");

  feed.push(lifecycleFrame(query.submittedUuid(), "started"));
  await feed.drained();
  expect(await started.submission).toBe("accepted");

  await session.close();
});

test("the consumed user-message replay proves acceptance when no lifecycle frame arrives", async () => {
  const feed = createFrameFeed();
  const { session, query } = await createScriptedClaudeSession(feed);

  const started = await session.startTurn("hello");
  if (!started.submission) throw new Error("Claude must expose a submission outcome");
  feed.push(initFrame());
  feed.push(userReplayFrame("unrelated-user-row"));
  await feed.drained();
  expect(await outcomeNow(started.submission)).toBe("pending");

  feed.push(userReplayFrame(query.submittedUuid()));
  await feed.drained();
  expect(await started.submission).toBe("accepted");

  await session.close();
});

test("a turn that ends without any correlated frame is unknown", async () => {
  const feed = createFrameFeed();
  const { session } = await createScriptedClaudeSession(feed);
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  const started = await session.startTurn("hello");
  feed.push(initFrame());
  feed.push(resultFrame());
  expect(await started.submission).toBe("unknown");
  expect(events.some((event) => event.type === "turn_completed")).toBe(true);

  await session.close();
});

test("a query that fails before the push leaves the prompt unsent and still returns the turn", async () => {
  const feed = createFrameFeed();
  const { session } = await createScriptedClaudeSession(feed, {
    failToStart: new Error("claude binary missing"),
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  const started = await session.startTurn("hello");
  expect(started.turnId).toMatch(/.+/);
  expect(await started.submission).toBe("unsent");
  expect(events.map((event) => event.type)).toEqual(["turn_started", "turn_failed"]);

  await session.close();
});

test("a confirmed withdrawal on interrupt proves the prompt was never read", async () => {
  const feed = createFrameFeed();
  const { session, query } = await createScriptedClaudeSession(feed, {
    cancelAsyncMessage: async () => true,
  });

  const started = await session.startTurn("hello");
  await session.interrupt();
  expect(await started.submission).toBe("unsent");
  expect(query.cancelled).toEqual([query.submittedUuid()]);

  await session.close();
});

test("an interrupt whose withdrawal is refused leaves the outcome unknown", async () => {
  const feed = createFrameFeed();
  const { session } = await createScriptedClaudeSession(feed, {
    cancelAsyncMessage: async () => false,
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  const started = await session.startTurn("hello");
  await session.interrupt();
  expect(await started.submission).toBe("unknown");
  expect(events.some((event) => event.type === "turn_canceled")).toBe(true);

  await session.close();
});

test("closing the session with the prompt in flight settles unknown", async () => {
  const feed = createFrameFeed();
  const { session } = await createScriptedClaudeSession(feed);

  const started = await session.startTurn("hello");
  await session.close();
  expect(await started.submission).toBe("unknown");
});

test("refusing to start tags the error as unsent", async () => {
  const feed = createFrameFeed();
  const { session } = await createScriptedClaudeSession(feed);
  await session.close();

  const failure = await session.startTurn("hello").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(readTurnSubmissionOutcome(failure)).toBe("unsent");
});
