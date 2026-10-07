import type { AgentBackgroundTask } from "@getpaseo/protocol/agent-types";

import type { PullRequestReviewDecision } from "../../services/forge-service.js";
import type { PullRequestWatch } from "./watch-store.js";

export const PULL_REQUEST_WATCH_TASK_SOURCE = "pull-request-watch";
export const PULL_REQUEST_WATCH_TASK_PREFIX = `${PULL_REQUEST_WATCH_TASK_SOURCE}:`;
const PULL_REQUEST_WATCH_TASK_TYPE = "pull_request_watch";

/** What the last read of a watched pull request showed. */
export interface WatchedPullRequestState {
  pendingChecks: number;
  failedChecks: number;
  passed: boolean;
  reviewDecision: PullRequestReviewDecision;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeWaitingOn(state: WatchedPullRequestState): string | null {
  const awaitingReview = state.reviewDecision === "pending";
  if (state.pendingChecks > 0) return `${plural(state.pendingChecks, "check")} running`;
  if (state.failedChecks > 0) return `${plural(state.failedChecks, "check")} failed`;
  if (state.reviewDecision === "changes_requested") return "changes requested";
  if (state.passed && awaitingReview) return "checks passed, waiting for review";
  if (awaitingReview) return "waiting for review";
  if (state.passed) return "checks passed";
  return null;
}

export function describePullRequestWatch(
  number: number,
  state: WatchedPullRequestState | null,
): string {
  const waitingOn = state ? describeWaitingOn(state) : null;
  return waitingOn ? `Watching PR #${number} · ${waitingOn}` : `Watching PR #${number}`;
}

export function toPullRequestWatchTask(
  watch: PullRequestWatch,
  state: WatchedPullRequestState | null,
): AgentBackgroundTask {
  return {
    id: `${PULL_REQUEST_WATCH_TASK_PREFIX}${watch.id}`,
    taskType: PULL_REQUEST_WATCH_TASK_TYPE,
    description: describePullRequestWatch(watch.number, state),
    startedAt: watch.startedAt,
  };
}
