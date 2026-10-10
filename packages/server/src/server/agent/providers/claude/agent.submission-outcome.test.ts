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

test("Stop reaches the CLI without a withdrawal round trip, and A's cleanup never interrupts B", async () => {
  const feed = createFrameFeed();
  const { session, query } = await createScriptedClaudeSession(feed, {
    cancelAsyncMessage: () => new Promise<boolean>(() => undefined),
  });

  const first = await session.startTurn("first");
  feed.push(initFrame());
  feed.push(lifecycleFrame(query.submittedUuid(0), "started"));
  await feed.drained();
  expect(await first.submission).toBe("accepted");

  const nativeInterrupt = query.nextInterrupt();
  await session.interrupt();
  expect(await nativeInterrupt).toBe(query.submittedUuid(0));

  const second = await session.startTurn("second");
  feed.push(lifecycleFrame(query.submittedUuid(1), "started"));
  await feed.drained();
  expect(await second.submission).toBe("accepted");
  expect(await first.submission).toBe("accepted");
  expect(query.interrupts).toEqual([query.submittedUuid(0)]);
  expect(query.withdrawals).toEqual([]);

  await session.close();
});

test("a cancelled lifecycle frame for the submitted uuid proves the prompt was never read", async () => {
  const feed = createFrameFeed();
  const { session, query } = await createScriptedClaudeSession(feed);

  const started = await session.startTurn("hello");
  feed.push(lifecycleFrame(query.submittedUuid(), "cancelled"));
  await feed.drained();
  expect(await started.submission).toBe("unsent");

  await session.close();
});

test("an interrupt before any evidence withdraws the prompt: confirmed means unsent, refused means unknown", async () => {
  for (const [withdrawn, outcome] of [
    [true, "unsent"],
    [false, "unknown"],
  ] as const) {
    const feed = createFrameFeed();
    const { session, query } = await createScriptedClaudeSession(feed, {
      cancelAsyncMessage: async () => withdrawn,
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const started = await session.startTurn("hello");
    await session.interrupt();
    expect(await started.submission).toBe(outcome);
    expect(events.some((event) => event.type === "turn_canceled")).toBe(true);
    expect(query.withdrawals).toEqual([query.submittedUuid()]);

    await session.close();
  }
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
