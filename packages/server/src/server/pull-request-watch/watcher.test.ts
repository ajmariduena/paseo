import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import type {
  CurrentPullRequestStatus,
  PullRequestCheck,
  PullRequestMergeable,
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
import {
  PULL_REQUEST_UNREADABLE_LIMIT_MS,
  PullRequestWatcher,
  type PullRequestWatchForgeService,
} from "./watcher.js";

const PR_URL = "https://github.com/acme/app/pull/42";
const AGENT_LOGIN = "agent-bot";

interface FakeForge {
  service: PullRequestWatchForgeService;
  state: string;
  checks: PullRequestCheck[];
  requiredCheckNames: string[];
  mergeable: PullRequestMergeable;
  remarks: PullRequestTimelineItem[];
  unreadable: boolean;
}

/** An in-memory forge for one open pull request, #42 on branch `feature`. */
function createFakeForge(): FakeForge {
  const forge: FakeForge = {
    state: "OPEN",
    checks: [],
    requiredCheckNames: [],
    mergeable: "MERGEABLE",
    remarks: [],
    unreadable: false,
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
          isMerged: merged,
          mergeable: forge.mergeable,
          checks: forge.checks,
          checksStatus: "pending",
          reviewDecision: null,
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
  host: ControlledHost;
  forge: FakeForge;
  store: PullRequestWatchStore;
  watcher: PullRequestWatcher;
  clock: { now: number };
  agentId: string;
}

let scenario: Scenario | null = null;

afterEach(async () => {
  scenario?.watcher.close();
  await scenario?.host.cleanup();
  scenario = null;
});

async function startWatching(options: { busy?: boolean } = {}): Promise<Scenario> {
  const host = createControlledHost();
  const forge = createFakeForge();
  const store = new PullRequestWatchStore(join(host.root, "pull-request-watches.json"));
  const clock = { now: Date.parse("2026-10-04T12:00:00Z") };
  const watcher = new PullRequestWatcher({
    store,
    agentManager: host.agentManager,
    agentStorage: host.agentStorage,
    resolveForge: async () => ({ service: forge.service }),
    readWorkspacePullRequestNumber: async () => 42,
    now: () => clock.now,
    logger: host.logger,
  });
  const agentId = await host.createAgent({ steerable: false });
  if (options.busy) await host.startTurn(agentId, "agent work");
  scenario = { host, forge, store, watcher, clock, agentId };
  return scenario;
}

async function watch(current: Scenario) {
  return await current.watcher.watch({ agentId: current.agentId, cwd: current.host.root });
}

async function sweep(current: Scenario): Promise<void> {
  current.clock.now += 60_000;
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

test("a pull request unreadable for 15 minutes ends the watch with a wake saying so", async () => {
  const current = await startWatching();
  await watch(current);

  current.forge.unreadable = true;
  await sweep(current);
  current.clock.now += PULL_REQUEST_UNREADABLE_LIMIT_MS - 120_000;
  await sweep(current);
  expect(await current.store.list()).toHaveLength(1);
  await sweep(current);

  expect(await current.store.list()).toEqual([]);
  expect(prompts(current)).toEqual([
    expect.stringContaining(
      "Paseo stopped watching pull request #42 (https://github.com/acme/app/pull/42) because it could not read it from the forge for 15 minutes.",
    ),
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

test("watching a closed pull request fails", async () => {
  const current = await startWatching();
  current.forge.state = "CLOSED";

  await expect(watch(current)).rejects.toThrow(
    "Pull request #42 is closed; only an open pull request can be watched.",
  );
});
