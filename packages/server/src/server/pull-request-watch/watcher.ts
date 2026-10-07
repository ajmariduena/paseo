import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type {
  CurrentPullRequestStatus,
  ForgeService,
  PullRequestTimelineItem,
} from "../../services/forge-service.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { dispatchAgentMessage, type SystemMessage } from "../agent/message-dispatch.js";
import {
  evaluatePullRequestWatch,
  renderPullRequestWake,
  renderUnreadableWake,
  type PullRequestObservation,
} from "./watch-report.js";
import { WatchLifetimes } from "./lifetimes.js";
import type { PullRequestWatch, PullRequestWatchStore, WatchProgress } from "./watch-store.js";

/** One pass a minute; a pull request is read on it only while a check runs or the read is due. */
export const PULL_REQUEST_WATCH_INTERVAL_MS = 60_000;
/**
 * How often a pull request with nothing in flight is read. Every watch on one forge account
 * shares its rate limit, so reading quiet pull requests faster mostly spends it.
 */
export const PULL_REQUEST_WATCH_QUIET_INTERVAL_MS = 2 * 60_000;
/** Reads in a row that failed for a reason other than a rate limit before the watch ends. */
export const PULL_REQUEST_READ_FAILURE_LIMIT = 8;

export type PullRequestWatchForgeService = Pick<
  ForgeService,
  | "getPullRequest"
  | "getCurrentPullRequestStatus"
  | "getPullRequestTimeline"
  | "getViewerLogin"
  | "getRequiredCheckNames"
  | "isRateLimitError"
>;

export interface PullRequestWatcherOptions {
  store: PullRequestWatchStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  resolveForge(cwd: string): Promise<{ service: PullRequestWatchForgeService } | null>;
  /** The number of the pull request for the checkout's current branch, if it has one. */
  readWorkspacePullRequestNumber(cwd: string): Promise<number | null>;
  now?: () => number;
  logger: Logger;
}

export interface PullRequestTarget {
  agentId: string;
  cwd: string;
  number?: number;
  url?: string;
}

export interface WatchPullRequestResult {
  number: number;
  url: string;
  title: string;
  watching: true;
  wasWatching: boolean;
  checks: { failed: string[]; pending: number; passed: boolean };
  conflicting: boolean;
}

export interface UnwatchPullRequestResult {
  number: number;
  url: string | null;
  watching: false;
  wasWatching: boolean;
}

type WakeOutcome = { kind: "final" } | { kind: "progress"; next: WatchProgress };

interface OpenReading {
  kind: "open";
  status: CurrentPullRequestStatus;
  observation: PullRequestObservation;
}

type Reading = OpenReading | { kind: "ended"; reason: "merged" | "closed" };

/** The last successful read of a pull request, kept in memory: a restart reads each once. */
interface LastRead {
  /** Start of the pass that read it, so passes a fixed interval apart compare exactly. */
  passStartedAt: number;
  /** A check was running, mergeability unknown, or remarks unread, so the next pass reads it. */
  inFlight: boolean;
  /** The watches it was read for; a watch added since takes its first look on the next pass. */
  watchIds: Set<string>;
}

type GroupOutcome = "read" | "rate-limited";

function isOpenState(state: string): boolean {
  return state.toLowerCase().startsWith("open");
}

function ended(state: string): Reading {
  return { kind: "ended", reason: state.toLowerCase() === "merged" ? "merged" : "closed" };
}

/** The number in a pull request or merge request URL, or null when the URL has none. */
export function parsePullRequestNumber(url: string): number | null {
  const match = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * Watches pull requests for agents (`watch_pull_request`). Each pass reads a watched pull request
 * once for every agent watching it, every minute while something is in flight and every two
 * minutes otherwise, and wakes each agent, without interrupting it, when a check fails, the
 * required checks pass, someone else comments or reviews, or the branch starts to conflict.
 * Progress is recorded only once the wake was delivered, so a wake lost to a restart is found
 * again on the next pass. A rate limit skips the pass and never ends a watch.
 */
export class PullRequestWatcher {
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly wakesInFlight = new Map<string, Promise<void>>();
  // Per pull request URL. Kept in memory: a restart only delays giving up.
  private readonly readFailures = new Map<string, number>();
  private readonly lastReads = new Map<string, LastRead>();
  private readonly viewers = new Map<string, string>();
  private readonly lifetimes: WatchLifetimes;
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(private readonly options: PullRequestWatcherOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger.child({ module: "pull-request-watch" });
    this.lifetimes = new WatchLifetimes(this.now, this.logger);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), PULL_REQUEST_WATCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async watch(target: PullRequestTarget): Promise<WatchPullRequestResult> {
    const service = await this.requireForge(target.cwd);
    const number = await this.resolveNumber(target);
    const summary = await service.getPullRequest({ cwd: target.cwd, number });
    if (target.url !== undefined && !sameRepository(target.url, summary.url)) {
      throw new Error(
        `${target.url} is not in this workspace's repository; pull request #${number} here is ${summary.url}.`,
      );
    }
    if (!isOpenState(summary.state)) {
      throw new Error(
        `Pull request #${number} is ${summary.state.toLowerCase()}; only an open pull request can be watched.`,
      );
    }
    const draft: PullRequestWatch = {
      id: randomUUID(),
      agentId: target.agentId,
      cwd: target.cwd,
      number,
      url: summary.url,
      title: summary.title,
      headRefName: summary.headRefName,
      startedAt: new Date(this.now()).toISOString(),
      progress: {
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: Math.floor(this.now() / 1000) * 1000,
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
    };
    const reading = await this.read(draft, service);
    if (reading.kind === "ended") {
      throw new Error(`Pull request #${number} is no longer open.`);
    }
    // The agent reads the current state in this result, so only later changes wake it.
    const baseline = evaluatePullRequestWatch(draft.progress, reading.observation).next;
    const { watch, added } = await this.options.store.add({
      ...draft,
      progress: { ...baseline, wakes: 0 },
    });
    const checks = reading.observation.checks;
    return {
      number,
      url: watch.url,
      title: watch.title,
      watching: true,
      wasWatching: !added,
      checks: {
        failed: baseline.failedChecks,
        pending: checks.filter((check) => check.status === "pending").length,
        passed: baseline.passed,
      },
      conflicting: baseline.conflicting,
    };
  }

  async unwatch(target: PullRequestTarget): Promise<UnwatchPullRequestResult> {
    const number = await this.resolveNumber(target);
    const watches = await this.options.store.list();
    const watch = watches.find(
      (candidate) =>
        candidate.agentId === target.agentId &&
        candidate.number === number &&
        (target.url === undefined || sameRepository(target.url, candidate.url)),
    );
    if (!watch) {
      return { number, url: null, watching: false, wasWatching: false };
    }
    if (await this.options.store.remove(watch.id)) this.lifetimes.ended(watch, "unwatched");
    return { number, url: watch.url, watching: false, wasWatching: true };
  }

  async disposeForAgent(agentId: string): Promise<void> {
    for (const watch of await this.options.store.removeForAgent(agentId)) {
      this.lifetimes.ended(watch, "archived");
    }
  }

  /** One pass over every watched pull request. Overlapping calls share the running pass. */
  sweep(): Promise<void> {
    this.sweeping ??= this.runSweep().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  /** Resolves once every wake dispatched so far has settled. */
  async idle(): Promise<void> {
    await Promise.all(this.wakesInFlight.values());
  }

  private async runSweep(): Promise<void> {
    const passStartedAt = this.now();
    let watches: PullRequestWatch[];
    try {
      watches = await this.options.store.list();
    } catch (error) {
      this.logger.error({ err: error }, "pull_request_watch.list_failed");
      return;
    }
    this.lifetimes.endMissing(watches);
    const groups = new Map<string, PullRequestWatch[]>();
    for (const watch of watches) {
      if (this.wakesInFlight.has(watch.id)) continue;
      try {
        if (!(await this.keep(watch))) continue;
      } catch (error) {
        this.logger.warn({ err: error, watchId: watch.id }, "pull_request_watch.check_failed");
        continue;
      }
      const key = stripUrl(watch.url);
      groups.set(key, [...(groups.get(key) ?? []), watch]);
    }
    for (const cache of [this.readFailures, this.lastReads]) {
      for (const key of cache.keys()) if (!groups.has(key)) cache.delete(key);
    }
    for (const [key, group] of groups) {
      if (!this.isDue(key, group, passStartedAt)) continue;
      try {
        // Every other read this pass would be refused too, so the pass ends here.
        if ((await this.checkGroup(key, group, passStartedAt)) === "rate-limited") return;
      } catch (error) {
        this.logger.warn({ err: error, pullRequest: key }, "pull_request_watch.check_failed");
      }
    }
  }

  /** Ends the watch, without a read, when its agent is gone. */
  private async keep(watch: PullRequestWatch): Promise<boolean> {
    const record = await this.options.agentStorage.get(watch.agentId);
    if (!record || record.archivedAt) {
      await this.options.store.remove(watch.id);
      this.lifetimes.ended(watch, "archived");
      return false;
    }
    return true;
  }

  private isDue(key: string, group: PullRequestWatch[], passStartedAt: number): boolean {
    const last = this.lastReads.get(key);
    if (!last || last.inFlight) return true;
    if (group.some((watch) => !last.watchIds.has(watch.id))) return true;
    return passStartedAt - last.passStartedAt >= PULL_REQUEST_WATCH_QUIET_INTERVAL_MS;
  }

  /** Reads one pull request once and evaluates it for every watch on it. */
  private async checkGroup(
    key: string,
    group: PullRequestWatch[],
    passStartedAt: number,
  ): Promise<GroupOutcome> {
    const [first] = group;
    if (!first) return "read";
    let service: PullRequestWatchForgeService | null = null;
    let reading: Reading;
    try {
      service = await this.requireForge(first.cwd);
      reading = await this.read(first, service);
    } catch (error) {
      this.lastReads.delete(key);
      if (service?.isRateLimitError?.(error)) {
        this.logger.debug({ err: error, pullRequest: key }, "pull_request_watch.rate_limited");
        return "rate-limited";
      }
      await this.noteUnreadable(key, group, error);
      return "read";
    }
    this.readFailures.delete(key);
    if (reading.kind === "ended") {
      this.lastReads.delete(key);
      for (const watch of group) {
        await this.options.store.remove(watch.id);
        this.lifetimes.ended(watch, reading.reason);
      }
      return "read";
    }
    const { observation } = reading;
    for (const watch of group) this.lifetimes.read(watch, observation.headSha);
    this.lastReads.set(key, {
      passStartedAt,
      inFlight:
        observation.mergeable === "UNKNOWN" ||
        observation.remarks === null ||
        observation.checks.some((check) => check.status === "pending"),
      watchIds: new Set(group.map((watch) => watch.id)),
    });
    for (const watch of group) {
      try {
        await this.evaluate(watch, reading);
      } catch (error) {
        this.lastReads.delete(key);
        this.logger.warn({ err: error, watchId: watch.id }, "pull_request_watch.check_failed");
      }
    }
    return "read";
  }

  private async evaluate(watch: PullRequestWatch, reading: OpenReading): Promise<void> {
    const report = evaluatePullRequestWatch(watch.progress, reading.observation);
    if (report.changes.length === 0) {
      if (!sameProgress(report.next, watch.progress)) {
        await this.options.store.recordProgress(watch, report.next);
      }
      return;
    }
    const message = renderPullRequestWake({
      number: watch.number,
      url: watch.url,
      baseRefName: reading.status.baseRefName,
      report,
    });
    if (report.exhausted) {
      await this.options.store.remove(watch.id);
      this.wake(watch, message, { kind: "final" });
      this.lifetimes.ended(watch, "comment-limit");
      return;
    }
    this.wake(watch, message, { kind: "progress", next: report.next });
  }

  private async noteUnreadable(
    key: string,
    group: PullRequestWatch[],
    error: unknown,
  ): Promise<void> {
    const failures = (this.readFailures.get(key) ?? 0) + 1;
    this.logger.debug({ err: error, pullRequest: key, failures }, "pull_request_watch.read_failed");
    if (failures < PULL_REQUEST_READ_FAILURE_LIMIT) {
      this.readFailures.set(key, failures);
      return;
    }
    this.readFailures.delete(key);
    for (const watch of group) {
      await this.options.store.remove(watch.id);
      this.wake(
        watch,
        renderUnreadableWake({
          number: watch.number,
          url: watch.url,
          failures: PULL_REQUEST_READ_FAILURE_LIMIT,
        }),
        { kind: "final" },
      );
      this.lifetimes.ended(watch, "unreadable");
    }
  }

  private wake(watch: PullRequestWatch, message: SystemMessage, outcome: WakeOutcome): void {
    this.lifetimes.woke(watch);
    const delivery = this.deliverWake(watch, message, outcome)
      .catch((error: unknown) => {
        this.logger.warn({ err: error, watchId: watch.id }, "pull_request_watch.wake_failed");
      })
      .finally(() => {
        this.wakesInFlight.delete(watch.id);
      });
    this.wakesInFlight.set(watch.id, delivery);
  }

  /**
   * Never interrupts: steers into a running turn when the provider can, otherwise waits in the
   * agent's queue. A progress wake is dropped if the watch ended while it waited.
   */
  private async deliverWake(
    watch: PullRequestWatch,
    message: SystemMessage,
    outcome: WakeOutcome,
  ): Promise<void> {
    const { store, agentManager, agentStorage } = this.options;
    const disposition = await dispatchAgentMessage({
      agentManager,
      agentStorage,
      agentId: watch.agentId,
      messageId: `pr-watch:${watch.id}:${randomUUID()}`,
      policy: {
        kind: "system",
        maySteer: true,
        prepare: async () => {
          if (outcome.kind === "final") return message;
          const current = await store.get(watch.id);
          return current?.startedAt === watch.startedAt ? message : null;
        },
        queueAs: { origin: "system" },
      },
      logger: this.logger,
    });
    this.logger.trace({ watchId: watch.id, disposition }, "pull_request_watch.woke");
    if (disposition === "skipped_archived") {
      for (const removed of await store.removeForAgent(watch.agentId)) {
        this.lifetimes.ended(removed, "archived");
      }
    } else if (outcome.kind === "progress") {
      await store.recordProgress(watch, outcome.next);
    }
  }

  private async read(
    watch: PullRequestWatch,
    service: PullRequestWatchForgeService,
  ): Promise<Reading> {
    const { cwd, number } = watch;
    const status = await service.getCurrentPullRequestStatus({ cwd, headRef: watch.headRefName });
    const matches =
      status !== null &&
      (status.number === number || (status.number === undefined && status.url === watch.url));
    if (!matches) {
      const summary = await service.getPullRequest({ cwd, number });
      if (!isOpenState(summary.state)) return ended(summary.state);
      throw new Error(`No status for pull request #${number} on ${watch.headRefName}`);
    }
    if (status.isMerged) return { kind: "ended", reason: "merged" };
    if (!isOpenState(status.state)) return ended(status.state);
    const [requiredCheckNames, viewer] = await Promise.all([
      this.readRequiredCheckNames(service, cwd, number),
      this.readViewer(service, cwd),
    ]);
    const remarks = viewer === null ? null : await this.readRemarks(service, watch, status);
    return {
      kind: "open",
      status,
      observation: {
        headSha: status.headSha ?? null,
        checks: status.checks,
        requiredCheckNames,
        mergeable: status.mergeable,
        remarks,
        viewer,
      },
    };
  }

  private async readRequiredCheckNames(
    service: PullRequestWatchForgeService,
    cwd: string,
    number: number,
  ): Promise<string[]> {
    try {
      return (await service.getRequiredCheckNames?.({ cwd, number })) ?? [];
    } catch (error) {
      if (service.isRateLimitError?.(error)) throw error;
      this.logger.debug({ err: error, cwd, number }, "pull_request_watch.required_checks_failed");
      return [];
    }
  }

  private async readViewer(
    service: PullRequestWatchForgeService,
    cwd: string,
  ): Promise<string | null> {
    const known = this.viewers.get(cwd);
    if (known) return known;
    try {
      const viewer = (await service.getViewerLogin?.({ cwd })) ?? null;
      if (viewer) this.viewers.set(cwd, viewer);
      return viewer;
    } catch (error) {
      if (service.isRateLimitError?.(error)) throw error;
      this.logger.debug({ err: error, cwd }, "pull_request_watch.viewer_failed");
      return null;
    }
  }

  private async readRemarks(
    service: PullRequestWatchForgeService,
    watch: PullRequestWatch,
    status: CurrentPullRequestStatus,
  ): Promise<PullRequestTimelineItem[] | null> {
    const timeline = await service.getPullRequestTimeline({
      cwd: watch.cwd,
      prNumber: watch.number,
      repoOwner: status.repoOwner ?? "",
      repoName: status.repoName ?? "",
    });
    return timeline.error ? null : timeline.items;
  }

  private async requireForge(cwd: string): Promise<PullRequestWatchForgeService> {
    const resolution = await this.options.resolveForge(cwd);
    if (!resolution) {
      throw new Error(`No supported forge remote for ${cwd}`);
    }
    return resolution.service;
  }

  private async resolveNumber(target: PullRequestTarget): Promise<number> {
    if (target.number !== undefined) return target.number;
    if (target.url !== undefined) {
      const number = parsePullRequestNumber(target.url);
      if (number === null) throw new Error(`Not a pull request URL: ${target.url}`);
      return number;
    }
    const number = await this.options.readWorkspacePullRequestNumber(target.cwd);
    if (number === null) {
      throw new Error(
        "Your workspace's branch has no pull request. Pass the pull request's number or url.",
      );
    }
    return number;
  }
}

function stripUrl(value: string): string {
  return value
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function sameRepository(url: string, canonicalUrl: string): boolean {
  const candidate = stripUrl(url);
  const canonical = stripUrl(canonicalUrl);
  return candidate === canonical || candidate.startsWith(`${canonical}/`);
}

function sameProgress(left: WatchProgress, right: WatchProgress): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
