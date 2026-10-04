import { CHECK_TRAIT_ACTION_REQUIRED } from "@getpaseo/protocol/check-traits";

import type {
  PullRequestCheck,
  PullRequestMergeable,
  PullRequestTimelineItem,
} from "../../services/forge-service.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { SystemMessage } from "../agent/message-dispatch.js";
import type { WatchProgress } from "./watch-store.js";

/**
 * Comment-only wakes in a row before watching stops. Check or conflict news resets the count,
 * so this only stops a chatty bot looping an agent that keeps replying to it.
 */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;

export interface PullRequestObservation {
  checks: PullRequestCheck[];
  /** Empty when the forge marks no check required; every check then gates "passed". */
  requiredCheckNames: string[];
  mergeable: PullRequestMergeable;
  /** Null when the conversation or the viewer could not be read; remarks then wait. */
  remarks: PullRequestTimelineItem[] | null;
  /** The forge account the agent acts as; its own remarks never wake it. */
  viewer: string | null;
}

export type PullRequestWatchChange =
  | { kind: "checks-failed"; failed: PullRequestCheck[] }
  | { kind: "checks-passed"; count: number; required: boolean }
  | { kind: "remarks"; remarks: PullRequestTimelineItem[] }
  | { kind: "conflicting" };

export interface PullRequestWatchReport {
  /** What the agent has not been told yet. Empty means no wake. */
  changes: PullRequestWatchChange[];
  next: WatchProgress;
  /** This report spends the last comment-only wake, so watching stops after it. */
  exhausted: boolean;
}

function isFailedCheck(check: PullRequestCheck): boolean {
  return (
    check.status === "failure" ||
    check.status === "cancelled" ||
    (check.traits?.includes(CHECK_TRAIT_ACTION_REQUIRED) ?? false)
  );
}

/**
 * Compares a watched pull request with what its agent was last told. A check is reported as
 * soon as it fails, so a check that never finishes cannot hold the news back. "Passed" is
 * reported once every required check passed, or every check when none is required.
 */
export function evaluatePullRequestWatch(
  progress: WatchProgress,
  observation: PullRequestObservation,
): PullRequestWatchReport {
  const changes: PullRequestWatchChange[] = [];

  // An empty list keeps the last state: a forge can answer with one when its check read fails.
  let { failedChecks, passed } = progress;
  if (observation.checks.length > 0) {
    const failed = observation.checks.filter(isFailedCheck);
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) changes.push({ kind: "checks-failed", failed: newlyFailed });
    // A rerun leaves the list while pending, so failing again is reported again.
    failedChecks = failed.map((check) => check.name);

    const required = observation.checks.filter((check) =>
      observation.requiredCheckNames.includes(check.name),
    );
    const gate = required.length > 0 ? required : observation.checks;
    const passedNow = gate.every((check) => check.status !== "pending" && !isFailedCheck(check));
    if (passedNow && !passed) {
      changes.push({ kind: "checks-passed", count: gate.length, required: required.length > 0 });
    }
    passed = passedNow;
  }

  const { remarksThrough, remarkIds } = progress;
  const own = observation.viewer?.toLowerCase();
  const fresh =
    own === undefined
      ? []
      : (observation.remarks ?? []).filter(
          (remark) =>
            (remark.createdAt > remarksThrough ||
              (remark.createdAt === remarksThrough && !remarkIds.includes(remark.id))) &&
            remark.author.toLowerCase() !== own,
        );
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(remarksThrough, ...fresh.map((remark) => remark.createdAt));
  const atLatest = fresh.filter((remark) => remark.createdAt === latest).map((r) => r.id);
  const nextRemarkIds = latest === remarksThrough ? [...remarkIds, ...atLatest] : atLatest;

  if (observation.mergeable === "CONFLICTING" && !progress.conflicting) {
    changes.push({ kind: "conflicting" });
  }
  // UNKNOWN is the forge still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    observation.mergeable === "UNKNOWN"
      ? progress.conflicting
      : observation.mergeable === "CONFLICTING";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const wakes = countWakes(progress.wakes, changes.length > 0, commentsOnly);
  return {
    changes,
    next: {
      failedChecks,
      passed,
      remarksThrough: latest,
      remarkIds: nextRemarkIds,
      conflicting,
      wakes,
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}

function countWakes(wakes: number, changed: boolean, commentsOnly: boolean): number {
  if (commentsOnly) return wakes + 1;
  return changed ? 0 : wakes;
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed<T>(items: T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

function remarkLine(remark: PullRequestTimelineItem): string {
  const where = remark.kind === "comment" && remark.location ? ` on ${remark.location.path}` : "";
  const body = snippet(remark.body);
  const fallback = remark.kind === "review" ? remark.reviewState.replace("_", " ") : "commented";
  const said = body.length === 0 ? fallback : `"${body}"`;
  return `  - ${remark.author}${where}: ${said} ${remark.url}`;
}

function changeLines(change: PullRequestWatchChange, baseRefName: string): string[] {
  switch (change.kind) {
    case "checks-failed":
      return [
        "- Checks failed:",
        ...listed(change.failed, (check) => {
          const status = check.status === "failure" ? "" : ` (${check.status})`;
          return `  - ${check.name}${status}${check.url ? ` ${check.url}` : ""}`;
        }),
      ];
    case "checks-passed": {
      const noun = change.count === 1 ? "check" : "checks";
      return [`- All ${change.count} ${change.required ? "required " : ""}${noun} passed.`];
    }
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, remarkLine),
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${baseRefName}.`];
  }
}

const SUMMARY: Record<PullRequestWatchChange["kind"], string> = {
  "checks-failed": "checks failed",
  "checks-passed": "checks passed",
  remarks: "new comments",
  conflicting: "merge conflict",
};

export interface PullRequestWakeInput {
  number: number;
  url: string;
  baseRefName: string;
  report: PullRequestWatchReport;
}

/** The wake the agent reads, and the notification row its timeline shows instead. */
export function renderPullRequestWake(input: PullRequestWakeInput): SystemMessage {
  const { changes, exhausted } = input.report;
  const text = [
    `Update on pull request #${input.number} (${input.url}), which Paseo is watching for you:`,
    ...changes.flatMap((change) => changeLines(change, input.baseRefName)),
    "",
    exhausted
      ? `Paseo stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again.`
      : "Look into each item and act on it as your task requires. Paseo keeps watching and wakes you on the next change, so end your turn when you are done. Call unwatch_pull_request when you no longer need updates.",
  ].join("\n");
  const failed = changes.some(
    (change) => change.kind === "checks-failed" || change.kind === "conflicting",
  );
  const summary = changes.map((change) => SUMMARY[change.kind]);
  if (exhausted) summary.push("stopped watching");
  return {
    prompt: formatSystemNotificationPrompt(text),
    notification: {
      level: failed ? "warning" : "info",
      message: `Pull request #${input.number}: ${summary.join(", ")}`,
    },
  };
}

export function renderUnreadableWake(input: {
  number: number;
  url: string;
  minutes: number;
}): SystemMessage {
  return {
    prompt: formatSystemNotificationPrompt(
      `Paseo stopped watching pull request #${input.number} (${input.url}) because it could not read it from the forge for ${input.minutes} minutes. Check it yourself, and call watch_pull_request to watch it again.`,
    ),
    notification: {
      level: "warning",
      message: `Pull request #${input.number}: stopped watching, could not read it`,
    },
  };
}
