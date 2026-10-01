import { describe, expect, it } from "vitest";
import {
  buildGitHubLinkSummariesQuery,
  createGitHubLinkSummaryLoader,
} from "./github-link-summaries.js";

const pr = { host: "github.com", owner: "getpaseo", repo: "paseo", number: 1482 };
const issue = { host: "github.com", owner: "getpaseo", repo: "paseo", number: 1390 };

function pullRequestAlias(input: { state: string; isDraft?: boolean; rollup?: string | null }) {
  return {
    issueOrPullRequest: {
      __typename: "PullRequest",
      title: "Fix compositor watchdog",
      state: input.state,
      isDraft: input.isDraft ?? false,
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: input.rollup ? { state: input.rollup } : null,
            },
          },
        ],
      },
    },
  };
}

describe("github link summaries", () => {
  it("aliases each ref and escapes owner and name", () => {
    const query = buildGitHubLinkSummariesQuery([pr, { ...issue, owner: 'a"b' }]);
    expect(query).toContain('l0: repository(owner: "getpaseo", name: "paseo")');
    expect(query).toContain("issueOrPullRequest(number: 1482)");
    expect(query).toContain('l1: repository(owner: "a\\"b", name: "paseo")');
  });

  it("maps pull requests and issues from one batched query", async () => {
    const queries: string[] = [];
    const loader = createGitHubLinkSummaryLoader({
      runQuery: async (query) => {
        queries.push(query);
        return {
          l0: pullRequestAlias({ state: "OPEN", isDraft: true, rollup: "EXPECTED" }),
          l1: { issueOrPullRequest: { __typename: "Issue", title: "Crash", state: "CLOSED" } },
        };
      },
    });

    const summaries = await loader.getSummaries([pr, issue]);

    expect(queries).toHaveLength(1);
    expect(summaries).toEqual([
      {
        ...pr,
        kind: "pull_request",
        state: "open",
        draft: true,
        title: "Fix compositor watchdog",
        checksStatus: "pending",
        available: true,
      },
      {
        ...issue,
        kind: "issue",
        state: "closed",
        draft: false,
        title: "Crash",
        checksStatus: null,
        available: true,
      },
    ]);
  });

  it("serves cached summaries until the state-based TTL expires", async () => {
    let nowMs = 0;
    let calls = 0;
    const loader = createGitHubLinkSummaryLoader({
      now: () => nowMs,
      runQuery: async () => {
        calls += 1;
        return { l0: pullRequestAlias({ state: "MERGED", rollup: "SUCCESS" }) };
      },
    });

    await loader.getSummaries([pr]);
    nowMs = 59 * 60_000;
    const cached = await loader.getSummaries([pr]);
    expect(calls).toBe(1);
    expect(cached[0]?.state).toBe("merged");

    nowMs = 61 * 60_000;
    await loader.getSummaries([pr]);
    expect(calls).toBe(2);
  });

  it("shares one in-flight request across concurrent callers", async () => {
    let calls = 0;
    const loader = createGitHubLinkSummaryLoader({
      runQuery: async () => {
        calls += 1;
        return { l0: pullRequestAlias({ state: "OPEN", rollup: "FAILURE" }) };
      },
    });

    const [first, second] = await Promise.all([
      loader.getSummaries([pr]),
      loader.getSummaries([pr, pr]),
    ]);

    expect(calls).toBe(1);
    expect(first[0]?.checksStatus).toBe("failure");
    expect(second.map((summary) => summary.number)).toEqual([1482, 1482]);
  });

  it("marks missing links unavailable and retries after a failed request", async () => {
    let fail = true;
    let calls = 0;
    const loader = createGitHubLinkSummaryLoader({
      runQuery: async () => {
        calls += 1;
        if (fail) throw new Error("network down");
        return { l0: { issueOrPullRequest: null } };
      },
    });

    const failed = await loader.getSummaries([pr]);
    expect(failed[0]).toMatchObject({ available: false, state: null });

    fail = false;
    const missing = await loader.getSummaries([pr]);
    expect(calls).toBe(2);
    expect(missing[0]).toMatchObject({ available: false });

    await loader.getSummaries([pr]);
    expect(calls).toBe(2);
  });
});
