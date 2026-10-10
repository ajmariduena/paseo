import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import type {
  CurrentPullRequestStatus,
  PullRequestCheck,
  PullRequestMergeable,
  PullRequestReviewDecision,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineItem,
} from "../../services/forge-service.js";
import {
  createControlledHost,
  type ControlledHost,
} from "../test-utils/controlled-agent-client.js";
import { PULL_REQUEST_WATCH_WAKE_LIMIT } from "./watch-report.js";
import { PullRequestWatchStore } from "./watch-store.js";
import { HandoffOwnership } from "../handoff/ownership.js";
import { syncFilePublication } from "../atomic-file.js";
import {
  PULL_REQUEST_READ_FAILURE_LIMIT,
  PULL_REQUEST_WATCH_INTERVAL_MS,
  PULL_REQUEST_WATCH_QUIET_INTERVAL_MS,
  PullRequestWatcher,
  type PullRequestWatchForgeService,
} from "./watcher.js";

const PR_URL = "https://github.com/acme/app/pull/42";
const AGENT_LOGIN = "agent-bot";

interface FakeForge {
  service: PullRequestWatchForgeService;
  state: string;
  headSha: string;
  checks: PullRequestCheck[];
  requiredCheckNames: string[];
  mergeable: PullRequestMergeable;
  reviewDecision: PullRequestReviewDecision;
  remarks: PullRequestTimelineItem[];
  unreadable: boolean;
  rateLimited: boolean;
  /** Pull request status reads, one per forge read of the pull request. */
  reads: number;
}

class FakeRateLimitError extends Error {}

/** An in-memory forge for one open pull request, #42 on branch `feature`. */
function createFakeForge(): FakeForge {
  const forge: FakeForge = {
    state: "OPEN",
    headSha: "aaa111",
    checks: [],
    requiredCheckNames: [],
    mergeable: "MERGEABLE",
    reviewDecision: null,
    remarks: [],
    unreadable: false,
    rateLimited: false,
    reads: 0,
    service: {
      async getPullRequest({ number }): Promise<PullRequestSummary> {
        if (forge.unreadable) throw new Error("gh: HTTP 502");
        return {
          number,
          title: "Add the widget",
          url: PR_URL,
          state: forge.state,
          body: null,
          baseRefName: "main",
          headRefName: "feature",
          labels: [],
          updatedAt: "2026-10-04T12:00:00Z",
        };
      },
      async getCurrentPullRequestStatus(): Promise<CurrentPullRequestStatus | null> {
        forge.reads += 1;
        if (forge.rateLimited) throw new FakeRateLimitError("API rate limit exceeded");
        if (forge.unreadable) throw new Error("gh: HTTP 502");
        const merged = forge.state === "MERGED";
        return {
          number: 42,
          repoOwner: "acme",
          repoName: "app",
          url: PR_URL,
          title: "Add the widget",
          state: forge.state.toLowerCase(),
          baseRefName: "main",
          headRefName: "feature",
          headSha: forge.headSha,
          isMerged: merged,
          mergeable: forge.mergeable,
          checks: forge.checks,
          checksStatus: "pending",
          reviewDecision: forge.reviewDecision,
        };
      },
      async getPullRequestTimeline(): Promise<PullRequestTimeline> {
        return {
          prNumber: 42,
          repoOwner: "acme",
          repoName: "app",
          items: forge.remarks,
          truncated: false,
          error: null,
        };
      },
      async getViewerLogin() {
        return AGENT_LOGIN;
      },
      async getRequiredCheckNames() {
        return forge.requiredCheckNames;
      },
      isRateLimitError(error) {
        return error instanceof FakeRateLimitError;
      },
    },
  };
  return forge;
}

function check(name: string, status: PullRequestCheck["status"]): PullRequestCheck {
  return { name, status, url: `https://ci.example/${name}` };
}

function comment(id: string, author: string, createdAt: number, body: string) {
  return {
    kind: "comment" as const,
    id,
    author,
    authorUrl: null,
    avatarUrl: null,
    body,
    createdAt,
    url: `${PR_URL}#${id}`,
  };
}

interface Scenario {
  handoffDirectory: string;
  ownership: HandoffOwnership;
  host: ControlledHost;
  forge: FakeForge;
  store: PullRequestWatchStore;
  watcher: PullRequestWatcher;
  clock: { now: number };
  agentId: string;
  /** The watcher's info log lines, parsed. */
  logs: Record<string, unknown>[];
}

let scenario: Scenario | null = null;

afterEach(async () => {
  scenario?.watcher.close();
  await scenario?.host.cleanup();
  if (scenario) await rm(scenario.handoffDirectory, { recursive: true, force: true });
  scenario = null;
});

async function startWatching(
  options: { busy?: boolean; sync?: typeof syncFilePublication } = {},
): Promise<Scenario> {
  const handoffDirectory = await mkdtemp(join(tmpdir(), "paseo-watch-handoff-"));
  const ownership = new HandoffOwnership({
    directory: join(handoffDirectory, "ownership"),
    sourceServerId: "source",
  });
  await ownership.initialize();
  const host = createControlledHost({ handoffOwnership: ownership });
  const forge = createFakeForge();
  const store = new PullRequestWatchStore(join(host.root, "pull-request-watches.json"), {
    sync: options.sync,
  });
  const clock = { now: Date.parse("2026-10-04T12:00:00Z") };
  const logs: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "info" },
    { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const watcher = new PullRequestWatcher({
    handoffOwnership: ownership,
    store,
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    resolveForge: async () => ({ service: forge.service }),
    readWorkspacePullRequestNumber: async () => 42,
    now: () => clock.now,
    logger,
  });
  const agentId = await host.createAgent({ steerable: false });
  if (options.busy) await host.startTurn(agentId, "agent work");
  scenario = { host, forge, store, watcher, clock, agentId, logs, ownership, handoffDirectory };
  return scenario;
}

async function watch(current: Scenario) {
  return await current.watcher.watch({ agentId: current.agentId, cwd: current.host.root });
}

/** Runs the pass a quiet pull request is next read on. */
async function sweep(
  current: Scenario,
  afterMs: number = PULL_REQUEST_WATCH_QUIET_INTERVAL_MS,
): Promise<void> {
  current.clock.now += afterMs;
  await current.watcher.sweep();
  await current.watcher.idle();
}

function prompts(current: Scenario): string[] {
  return current.host.session(current.agentId).startPrompts.map(String);
}

function notifications(current: Scenario) {
  return current.host.agentManager
    .getTimeline(current.agentId)
    .filter((item) => item.type === "notification");
}

async function fence(current: Scenario) {
  return current.ownership.prepare({
    id: randomUUID(),
    workspaceId: "workspace",
    cwd: current.host.root,
    agentIds: [current.agentId],
    destinationServerId: "destination",
    reservationId: randomUUID(),
  });
}

test.skipIf(process.platform === "win32").each(["progress", "final"] as const)(
  "handoff cancels queued %s PR notifications and retains a durable stopped disposition",
  async (kind) => {
    const current = await startWatching({ busy: true });
    await watch(current);
    const review = await current.watcher.reviewForHandoff([current.agentId]);
    expect(review).toEqual([
      expect.objectContaining({ agentId: current.agentId, number: 42, url: PR_URL }),
    ]);
    current.forge.checks = [check("test", "failure")];
    if (kind === "final") {
      current.forge.unreadable = true;
      for (let i = 1; i < PULL_REQUEST_READ_FAILURE_LIMIT; i++) await current.watcher.sweep();
    }
    await current.watcher.sweep();
    await vi.waitFor(() =>
      expect(current.host.agentManager.messageQueue.entries(current.agentId)).toHaveLength(1),
    );
    const source = await fence(current);
    await current.watcher.stopForHandoff([current.agentId], review);
    expect(current.host.agentManager.messageQueue.entries(current.agentId)).toEqual([]);
    expect(
      await new PullRequestWatchStore(join(current.host.root, "pull-request-watches.json")).list(),
    ).toEqual([]);
    current.host.session(current.agentId).completeTurn("done");
    await current.watcher.idle();
    expect(prompts(current)).toEqual(["agent work"]);
    await expect(watch(current)).rejects.toThrow("handoff");
    await current.ownership.cancelReservation({
      transferId: source.id,
      destinationServerId: "destination",
      reservationId: source.reservationId,
    });
    await sweep(current);
    expect(prompts(current)).toEqual(["agent work"]);
    expect(await current.store.list()).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "handoff retries an unacknowledged watch removal before certifying it",
  async () => {
    let fail = true;
    let publications = 0;
    const current = await startWatching({
      sync: async (...args) => {
        publications++;
        if (fail) throw new Error("Watch sync failed");
        await syncFilePublication(...args);
      },
    });
    await watch(current);
    const review = await current.watcher.reviewForHandoff([current.agentId]);
    await fence(current);
    await expect(current.watcher.stopForHandoff([current.agentId], review)).rejects.toThrow(
      "Watch sync failed",
    );
    expect(await current.store.list()).toEqual([]);
    fail = false;
    await current.watcher.stopForHandoff([current.agentId], review);
    expect(publications).toBe(2);
    expect(await current.watcher.reviewForHandoff([current.agentId])).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "a late final forge failure cannot wake a watch stopped by a cancelled handoff",
  async () => {
    const current = await startWatching();
    await watch(current);
    const review = await current.watcher.reviewForHandoff([current.agentId]);
    current.forge.unreadable = true;
    for (let i = 1; i < PULL_REQUEST_READ_FAILURE_LIMIT; i++) await current.watcher.sweep();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    current.forge.service.getCurrentPullRequestStatus = async () => {
      entered.resolve();
      await released.promise;
      throw new Error("Late forge failure");
    };
    const checking = current.watcher.sweep();
    await entered.promise;
    const source = await fence(current);
    await current.watcher.stopForHandoff([current.agentId], review);
    await current.ownership.cancelReservation({
      transferId: source.id,
      destinationServerId: "destination",
      reservationId: source.reservationId,
    });
    released.resolve();
    await checking;
    await current.watcher.idle();
    expect(prompts(current)).toEqual([]);
    expect(await current.store.list()).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "a PR watch registration waiting on the forge cannot cross handoff admission",
  async () => {
    const current = await startWatching();
    let continueRead = () => {};
    let enteredRead = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const held = new Promise<void>((resolve) => {
      continueRead = resolve;
    });
    const read = current.forge.service.getPullRequest;
    current.forge.service.getPullRequest = async (input) => {
      enteredRead();
      await held;
      return read(input);
    };
    const registering = watch(current);
    const refused = expect(registering).rejects.toThrow("handoff");
    await entered;
    const source = await fence(current);
    let drained = false;
    const draining = current.ownership.drain(source.id).then(() => {
      drained = true;
      return true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    continueRead();
    await refused;
    await draining;
    expect(drained).toBe(true);
    expect(await current.store.list()).toEqual([]);
  },
);

test("watching reports the current checks and wakes only on what changes later", async () => {
  const current = await startWatching();
  current.forge.checks = [check("lint", "failure"), check("test", "pending")];

  const result = await watch(current);

  expect(result).toEqual({
    number: 42,
    url: PR_URL,
    title: "Add the widget",
    watching: true,
    wasWatching: false,
    checks: { failed: ["lint"], pending: 1, passed: false },
    conflicting: false,
  });
  await sweep(current);
  expect(prompts(current)).toEqual([]);

  current.forge.checks = [check("lint", "failure"), check("test", "failure")];
  await sweep(current);

  expect(prompts(current)).toEqual([
    [
      "<paseo-system>",
      `Update on pull request #42 (${PR_URL}), which Paseo is watching for you:`,
      "- Checks failed:",
      "  - test https://ci.example/test",
      "",
      "Look into each item and act on it as your task requires. Paseo keeps watching and wakes you on the next change, so end your turn when you are done. Call unwatch_pull_request when you no longer need updates.",
      "</paseo-system>",
    ].join("\n"),
  ]);
  expect(notifications(current)).toEqual([
    {
      type: "notification",
      level: "warning",
      message: "Pull request #42: checks failed",
      messageId: expect.stringMatching(/^pr-watch:/),
    },
  ]);

  current.host.session(current.agentId).completeTurn("fixed");
  await sweep(current);
  expect(prompts(current)).toHaveLength(1);
});

test("required checks passing wakes once while an optional check is still pending", async () => {
  const current = await startWatching();
  current.forge.requiredCheckNames = ["build"];
  current.forge.checks = [check("build", "pending"), check("preview", "pending")];
  await watch(current);

  current.forge.checks = [check("build", "success"), check("preview", "pending")];
  await sweep(current);
  current.host.session(current.agentId).completeTurn("noted");
  current.forge.checks = [check("build", "success"), check("preview", "success")];
  await sweep(current);

  expect(prompts(current)).toEqual([expect.stringContaining("- All 1 required check passed.")]);
  expect(notifications(current)).toEqual([
    expect.objectContaining({ level: "info", message: "Pull request #42: checks passed" }),
  ]);
});

test("comments from someone else wake the agent, and its own comments do not", async () => {
  const current = await startWatching();
  const before = current.clock.now - 5_000;
  current.forge.remarks = [comment("c0", "reviewer", before, "older remark")];
  await watch(current);

  current.forge.remarks.push(
    comment("c1", AGENT_LOGIN, current.clock.now + 10_000, "On it"),
    comment("c2", "reviewer", current.clock.now + 20_000, "Please rename <!-- hidden --> this"),
  );
  await sweep(current);
  current.host.session(current.agentId).completeTurn("renamed");
  await sweep(current);

  expect(prompts(current)).toEqual([
    expect.stringContaining(`- 1 new comment:\n  - reviewer: "Please rename this" ${PR_URL}#c2\n`),
  ]);
});

test("a push resets the failed checks, so the same failure on the new head wakes again", async () => {
  const current = await startWatching();
  current.forge.checks = [check("test", "failure")];
  await watch(current);

  current.forge.headSha = "bbb222";
  current.forge.checks = [check("test", "pending")];
  await sweep(current);
  current.forge.checks = [check("test", "failure")];
  await sweep(current);

  expect(prompts(current)).toEqual([expect.stringContaining("  - test https://ci.example/test")]);
});

test("a push whose checks all finish between two passes still wakes", async () => {
  const current = await startWatching();
  current.forge.checks = [check("test", "success")];
  await watch(current);

  current.forge.headSha = "bbb222";
  await sweep(current);

  expect(prompts(current)).toEqual([expect.stringContaining("- All 1 check passed.")]);
});

test("a required check that first appears already passed wakes again", async () => {
  const current = await startWatching();
  current.forge.requiredCheckNames = ["tests", "gate"];
  current.forge.checks = [check("tests", "pending")];
  await watch(current);

  current.forge.checks = [check("tests", "success")];
  await sweep(current);
  current.host.session(current.agentId).completeTurn("noted");
  current.forge.checks = [check("tests", "success"), check("gate", "success")];
  await sweep(current);
  current.host.session(current.agentId).completeTurn("noted");
  current.forge.checks.push(check("advisory", "success"));
  await sweep(current);

  expect(prompts(current)).toEqual([
    expect.stringContaining("- All 1 required check passed."),
    expect.stringContaining("- All 2 required checks passed."),
  ]);
});

test("a watch saved before head and passed-check tracking adopts them without a wake", async () => {
  const current = await startWatching();
  current.forge.checks = [check("lint", "failure"), check("test", "success")];
  await writeFile(
    join(current.host.root, "pull-request-watches.json"),
    JSON.stringify({
      version: 1,
      watches: [
        {
          id: "legacy",
          agentId: current.agentId,
          cwd: current.host.root,
          number: 42,
          url: PR_URL,
          title: "Add the widget",
          headRefName: "feature",
          startedAt: "2026-10-01T12:00:00.000Z",
          progress: {
            failedChecks: ["lint"],
            passed: false,
            remarksThrough: 0,
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ],
    }),
  );

  await sweep(current);

  expect(prompts(current)).toEqual([]);
  expect((await current.store.get("legacy"))?.progress).toEqual({
    headSha: "aaa111",
    failedChecks: ["lint"],
    passed: false,
    passedChecks: [],
    remarksThrough: 0,
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  });
});

test("someone else editing a comment wakes the agent, and the edit is reported once", async () => {
  const current = await startWatching();
  const before = current.clock.now - 5_000;
  current.forge.remarks = [comment("c0", "review-bot", before, "1 issue found")];
  await watch(current);

  current.forge.remarks = [
    {
      ...comment("c0", "review-bot", before, "2 issues found"),
      editedAt: current.clock.now + 10_000,
    },
  ];
  await sweep(current);
  current.host.session(current.agentId).completeTurn("fixed");
  await sweep(current);

  expect(prompts(current)).toEqual([
    expect.stringContaining(`- 1 new comment:\n  - review-bot: "2 issues found" ${PR_URL}#c0\n`),
  ]);
});

test("a new merge conflict wakes the agent once", async () => {
  const current = await startWatching();
  await watch(current);

  current.forge.mergeable = "CONFLICTING";
  await sweep(current);
  current.host.session(current.agentId).completeTurn("rebasing");
  current.forge.mergeable = "UNKNOWN";
  await sweep(current);

  expect(prompts(current)).toEqual([
    expect.stringContaining("- The branch now conflicts with main."),
  ]);
});

test("a wake waits for a busy agent's turn instead of interrupting it", async () => {
  const current = await startWatching({ busy: true });
  await watch(current);

  current.forge.checks = [check("test", "failure")];
  await current.watcher.sweep();
  const session = current.host.session(current.agentId);
  await vi.waitFor(() =>
    expect(current.host.agentManager.messageQueue.entries(current.agentId)).toHaveLength(1),
  );
  expect(session.startPrompts).toEqual(["agent work"]);
  expect(session.interruptCount).toBe(0);

  session.completeTurn("done");
  await current.watcher.idle();
  expect(prompts(current)).toEqual(["agent work", expect.stringContaining("- Checks failed:")]);
  expect(session.interruptCount).toBe(0);
});

test("merging ends the watch without a wake", async () => {
  const current = await startWatching();
  await watch(current);

  current.forge.state = "MERGED";
  await sweep(current);

  expect(await current.store.list()).toEqual([]);
  expect(prompts(current)).toEqual([]);
});

test("failing to read a pull request 8 times in a row ends the watch with a wake saying so", async () => {
  const current = await startWatching();
  await watch(current);

  current.forge.unreadable = true;
  for (let pass = 1; pass < PULL_REQUEST_READ_FAILURE_LIMIT; pass += 1) {
    await sweep(current, PULL_REQUEST_WATCH_INTERVAL_MS);
  }
  expect(await current.store.list()).toHaveLength(1);
  await sweep(current, PULL_REQUEST_WATCH_INTERVAL_MS);

  expect(await current.store.list()).toEqual([]);
  expect(prompts(current)).toEqual([
    expect.stringContaining(
      "Paseo stopped watching pull request #42 (https://github.com/acme/app/pull/42) because it failed to read it from the forge 8 times in a row.",
    ),
  ]);
});

test("a rate limit skips the pass without ending the watch or counting as a failure", async () => {
  const current = await startWatching();
  await watch(current);

  current.forge.unreadable = true;
  for (let pass = 1; pass < PULL_REQUEST_READ_FAILURE_LIMIT; pass += 1) await sweep(current);
  current.forge.rateLimited = true;
  for (let pass = 0; pass < 20; pass += 1) await sweep(current);
  current.forge.rateLimited = false;
  current.forge.unreadable = false;
  current.forge.checks = [check("test", "failure")];
  await sweep(current);

  expect(await current.store.list()).toHaveLength(1);
  expect(prompts(current)).toEqual([expect.stringContaining("  - test https://ci.example/test")]);
});

test("agents watching the same pull request share one read per pass", async () => {
  const current = await startWatching();
  const sibling = await current.host.createAgent({ steerable: false });
  await watch(current);
  await current.watcher.watch({ agentId: sibling, cwd: current.host.root });
  current.forge.reads = 0;

  current.forge.checks = [check("test", "failure")];
  await sweep(current);

  expect(current.forge.reads).toBe(1);
  expect(prompts(current)).toEqual([expect.stringContaining("- Checks failed:")]);
  expect(current.host.session(sibling).startPrompts.map(String)).toEqual([
    expect.stringContaining("- Checks failed:"),
  ]);
});

test("a quiet pull request is read every two minutes, and every minute while checks run", async () => {
  const current = await startWatching();
  await watch(current);
  await sweep(current);
  current.forge.reads = 0;

  await sweep(current, PULL_REQUEST_WATCH_INTERVAL_MS);
  expect(current.forge.reads).toBe(0);
  current.forge.checks = [check("test", "pending")];
  await sweep(current, PULL_REQUEST_WATCH_INTERVAL_MS);
  expect(current.forge.reads).toBe(1);
  current.forge.checks = [check("test", "failure")];
  await sweep(current, PULL_REQUEST_WATCH_INTERVAL_MS);

  expect(current.forge.reads).toBe(2);
  expect(prompts(current)).toEqual([expect.stringContaining("- Checks failed:")]);
});

test("a subagent can watch the pull request it opened", async () => {
  const current = await startWatching();
  const child = await current.host.createAgent({
    steerable: false,
    labels: { [PARENT_AGENT_ID_LABEL]: current.agentId },
  });

  const result = await current.watcher.watch({ agentId: child, cwd: current.host.root });
  current.forge.checks = [check("test", "failure")];
  await sweep(current);

  expect(result.watching).toBe(true);
  expect(current.host.session(child).startPrompts).toEqual([
    expect.stringContaining("- Checks failed:"),
  ]);
});

test("comment-only wakes stop the watch after the limit", async () => {
  const current = await startWatching();
  await watch(current);
  const session = current.host.session(current.agentId);

  for (let index = 1; index <= PULL_REQUEST_WATCH_WAKE_LIMIT; index += 1) {
    current.forge.remarks.push(comment(`c${index}`, "bot", current.clock.now + 30_000, "ping"));
    await sweep(current);
    session.completeTurn("replied");
  }

  expect(prompts(current)).toHaveLength(PULL_REQUEST_WATCH_WAKE_LIMIT);
  expect(prompts(current).at(-1)).toContain(
    `Paseo stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row.`,
  );
  expect(await current.store.list()).toEqual([]);
});

test("unwatching and archiving end the watch", async () => {
  const current = await startWatching();
  await watch(current);

  expect(
    await current.watcher.unwatch({ agentId: current.agentId, cwd: current.host.root }),
  ).toEqual({ number: 42, url: PR_URL, watching: false, wasWatching: true });
  await watch(current);
  await current.watcher.disposeForAgent(current.agentId);
  current.forge.checks = [check("test", "failure")];
  await sweep(current);

  expect(await current.store.list()).toEqual([]);
  expect(prompts(current)).toEqual([]);
});

test("a watch survives a new watcher on the same store", async () => {
  const current = await startWatching();
  await watch(current);
  current.watcher.close();
  const restarted = new PullRequestWatcher({
    store: new PullRequestWatchStore(join(current.host.root, "pull-request-watches.json")),
    agentManager: current.host.agentManager,
    agentStorage: current.host.agentStorage,
    resolveForge: async () => ({ service: current.forge.service }),
    readWorkspacePullRequestNumber: async () => 42,
    now: () => current.clock.now,
    logger: current.host.logger,
  });

  current.forge.checks = [check("test", "failure")];
  await restarted.sweep();
  await restarted.idle();

  expect(prompts(current)).toEqual([expect.stringContaining("  - test https://ci.example/test")]);
});

test("an ended watch logs one line with how long it lived and stayed quiet", async () => {
  const current = await startWatching();
  await watch(current);
  await sweep(current);
  current.clock.now += 6 * 60 * 60_000 - PULL_REQUEST_WATCH_QUIET_INTERVAL_MS * 2;
  current.forge.headSha = "bbb222";
  await sweep(current);
  current.clock.now += 2 * 60 * 60_000 - PULL_REQUEST_WATCH_QUIET_INTERVAL_MS;
  await sweep(current);
  await current.watcher.unwatch({ agentId: current.agentId, cwd: current.host.root });
  await sweep(current);

  expect(current.logs.filter((line) => line.msg === "pull_request_watch.ended")).toEqual([
    expect.objectContaining({
      agentId: current.agentId,
      pullRequest: PR_URL,
      reason: "unwatched",
      minutes: 480,
      quietMinutes: 120,
      longestQuietMinutes: 360,
      wakes: 0,
      reads: 3,
      partial: false,
    }),
  ]);
});

test("a watch ended by a merge logs why", async () => {
  const current = await startWatching();
  await watch(current);

  current.forge.state = "MERGED";
  await sweep(current);

  expect(current.logs.filter((line) => line.msg === "pull_request_watch.ended")).toEqual([
    expect.objectContaining({ reason: "merged", reads: 0, wakes: 0 }),
  ]);
});

function tasks(current: Scenario) {
  return current.host.agentManager.listDaemonBackgroundTasks(current.agentId);
}

async function settleTurn(current: Scenario, text: string): Promise<void> {
  current.host.session(current.agentId).completeTurn(text);
  await vi.waitFor(() =>
    expect(current.host.agentManager.getAgent(current.agentId)?.lifecycle).toBe("idle"),
  );
}

test("an active watch is a background task of its agent that says what it waits for", async () => {
  const current = await startWatching();
  current.forge.checks = [check("lint", "pending"), check("test", "pending")];
  await watch(current);
  const [watched] = await current.store.list();

  expect(tasks(current)).toEqual([
    {
      id: `pull-request-watch:${watched?.id}`,
      taskType: "pull_request_watch",
      description: "Watching PR #42 · 2 checks running",
      startedAt: watched?.startedAt,
    },
  ]);

  current.forge.checks = [check("lint", "success"), check("test", "success")];
  current.forge.reviewDecision = "pending";
  await sweep(current);
  expect(tasks(current)).toEqual([
    expect.objectContaining({ description: "Watching PR #42 · checks passed, waiting for review" }),
  ]);

  await settleTurn(current, "noted");
  current.forge.state = "MERGED";
  await sweep(current);
  expect(tasks(current)).toEqual([]);
});

test("stopping the watch's background task unwatches the pull request", async () => {
  const current = await startWatching();
  current.watcher.start();
  await watch(current);
  const [task] = tasks(current);

  await current.host.agentManager.stopBackgroundTask(current.agentId, task?.id ?? "");
  current.forge.checks = [check("test", "failure")];
  await sweep(current);

  expect(await current.store.list()).toEqual([]);
  expect(tasks(current)).toEqual([]);
  expect(prompts(current)).toEqual([]);
});

test("a wake turn that ends while still watching does not ask for attention", async () => {
  const current = await startWatching();
  const { agentManager } = current.host;
  await watch(current);

  current.forge.checks = [check("test", "failure")];
  await sweep(current);
  await settleTurn(current, "fixed the test");
  expect(agentManager.getAgent(current.agentId)?.attention.requiresAttention).toBe(false);

  current.forge.state = "MERGED";
  await sweep(current);
  await vi.waitFor(() =>
    expect(agentManager.getAgent(current.agentId)?.attention).toMatchObject({
      requiresAttention: true,
      attentionReason: "finished",
    }),
  );
});

test("watching a closed pull request fails", async () => {
  const current = await startWatching();
  current.forge.state = "CLOSED";

  await expect(watch(current)).rejects.toThrow(
    "Pull request #42 is closed; only an open pull request can be watched.",
  );
});
