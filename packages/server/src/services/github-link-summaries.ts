import { z } from "zod";
import type { ForgeLinkRef, ForgeLinkSummary } from "./forge-service.js";

export const FORGE_LINK_SUMMARY_BATCH_MAX = 20;
export const FORGE_LINK_SUMMARY_REQUEST_MAX = 50;

const OPEN_TTL_MS = 2 * 60_000;
const PENDING_CHECKS_TTL_MS = 30_000;
const TERMINAL_TTL_MS = 60 * 60_000;
const UNAVAILABLE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 2_000;

export type GitHubGraphqlAliasRunner = (query: string) => Promise<Record<string, unknown>>;

const RollupStateSchema = z.enum(["SUCCESS", "PENDING", "EXPECTED", "FAILURE", "ERROR"]);

const IssueOrPullRequestSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("Issue"),
    title: z.string(),
    state: z.enum(["OPEN", "CLOSED"]),
  }),
  z.object({
    __typename: z.literal("PullRequest"),
    title: z.string(),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    commits: z.object({
      nodes: z.array(
        z.object({
          commit: z.object({
            statusCheckRollup: z.object({ state: RollupStateSchema }).nullable(),
          }),
        }),
      ),
    }),
  }),
]);

const PULL_REQUEST_STATES = { OPEN: "open", MERGED: "merged", CLOSED: "closed" } as const;

const AliasSchema = z.object({ issueOrPullRequest: IssueOrPullRequestSchema.nullable() });

export function forgeLinkKey(ref: ForgeLinkRef): string {
  return `${ref.host.toLowerCase()}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

export function buildGitHubLinkSummariesQuery(refs: ForgeLinkRef[]): string {
  const aliases = refs.map(
    (
      ref,
      index,
    ) => `  l${index}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(
      ref.repo,
    )}) {
    issueOrPullRequest(number: ${ref.number}) {
      __typename
      ... on Issue { title state }
      ... on PullRequest {
        title
        state
        isDraft
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }`,
  );
  return `query PaseoLinkSummaries {\n${aliases.join("\n")}\n}`;
}

function toChecksStatus(state: z.infer<typeof RollupStateSchema> | undefined) {
  if (!state) return null;
  if (state === "SUCCESS") return "success";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "failure";
}

export function unavailableForgeLinkSummary(ref: ForgeLinkRef): ForgeLinkSummary {
  return {
    ...ref,
    kind: null,
    state: null,
    draft: false,
    title: null,
    checksStatus: null,
    available: false,
  };
}

export function parseGitHubLinkSummary(ref: ForgeLinkRef, aliasValue: unknown): ForgeLinkSummary {
  const parsed = AliasSchema.safeParse(aliasValue);
  const node = parsed.success ? parsed.data.issueOrPullRequest : null;
  if (!node) {
    return unavailableForgeLinkSummary(ref);
  }
  if (node.__typename === "Issue") {
    return {
      ...ref,
      kind: "issue",
      state: node.state === "OPEN" ? "open" : "closed",
      draft: false,
      title: node.title,
      checksStatus: null,
      available: true,
    };
  }
  return {
    ...ref,
    kind: "pull_request",
    state: PULL_REQUEST_STATES[node.state],
    draft: node.isDraft,
    title: node.title,
    checksStatus: toChecksStatus(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
    available: true,
  };
}

function ttlFor(summary: ForgeLinkSummary): number {
  if (!summary.available) return UNAVAILABLE_TTL_MS;
  if (summary.state !== "open") return TERMINAL_TTL_MS;
  return summary.checksStatus === "pending" ? PENDING_CHECKS_TTL_MS : OPEN_TTL_MS;
}

export function createGitHubLinkSummaryLoader(options: {
  runQuery: GitHubGraphqlAliasRunner;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { summary: ForgeLinkSummary; expiresAt: number }>();
  const inFlight = new Map<string, Promise<ForgeLinkSummary>>();

  function remember(summary: ForgeLinkSummary): void {
    const key = forgeLinkKey(summary);
    cache.delete(key);
    cache.set(key, { summary, expiresAt: now() + ttlFor(summary) });
    if (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  async function loadChunk(refs: ForgeLinkRef[]): Promise<ForgeLinkSummary[]> {
    let aliases: Record<string, unknown> = {};
    let failed = false;
    try {
      aliases = await options.runQuery(buildGitHubLinkSummariesQuery(refs));
    } catch {
      failed = true;
    }
    return refs.map((ref, index) => {
      const summary = parseGitHubLinkSummary(ref, aliases[`l${index}`]);
      // A failed request (network, auth, rate limit) is not evidence the link is
      // inaccessible, so it stays uncached and the next view retries.
      if (!failed || summary.available) remember(summary);
      return summary;
    });
  }

  async function getSummaries(refs: ForgeLinkRef[]): Promise<ForgeLinkSummary[]> {
    const results = new Map<string, Promise<ForgeLinkSummary>>();
    const missing: ForgeLinkRef[] = [];
    for (const ref of refs) {
      const key = forgeLinkKey(ref);
      if (results.has(key)) continue;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        results.set(key, Promise.resolve(cached.summary));
        continue;
      }
      const pending = inFlight.get(key);
      if (pending) {
        results.set(key, pending);
        continue;
      }
      missing.push(ref);
    }

    for (let start = 0; start < missing.length; start += FORGE_LINK_SUMMARY_BATCH_MAX) {
      const chunk = missing.slice(start, start + FORGE_LINK_SUMMARY_BATCH_MAX);
      const request = loadChunk(chunk);
      chunk.forEach((ref, index) => {
        const key = forgeLinkKey(ref);
        const single = request.then(
          (summaries) => summaries[index] ?? unavailableForgeLinkSummary(ref),
        );
        inFlight.set(key, single);
        void single.finally(() => {
          if (inFlight.get(key) === single) inFlight.delete(key);
        });
        results.set(key, single);
      });
    }

    return Promise.all(
      refs.map(
        (ref) =>
          results.get(forgeLinkKey(ref)) ?? Promise.resolve(unavailableForgeLinkSummary(ref)),
      ),
    );
  }

  return { getSummaries };
}
