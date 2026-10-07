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
import type { PullRequestWatch, PullRequestWatchStore, WatchProgress } from "./watch-store.js";

export const PULL_REQUEST_WATCH_INTERVAL_MS = 60_000;
export const PULL_REQUEST_UNREADABLE_LIMIT_MS = 15 * 60_000;

export type PullRequestWatchForgeService = Pick<
  ForgeService,
  | "getPullRequest"
  | "getCurrentPullRequestStatus"
  | "getPullRequestTimeline"
  | "getViewerLogin"
  | "getRequiredCheckNames"
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

type Reading =
  | { kind: "open"; status: CurrentPullRequestStatus; observation: PullRequestObservation }
  | { kind: "ended" };

function isOpenState(state: string): boolean {
  return state.toLowerCase().startsWith("open");
}

/** The number in a pull request or merge request URL, or null when the URL has none. */
export function parsePullRequestNumber(url: string): number | null {
  const match = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * Watches pull requests for agents (`watch_pull_request`). One pass a minute reads each watched
 * pull request through the forge layer and wakes the agent, without interrupting it, when a
 * check fails, the required checks pass, someone else comments or reviews, or the branch starts
 * to conflict. Progress is recorded only once the wake was delivered, so a wake lost to a
 * restart is found again on the next pass.
 */
export class PullRequestWatcher {
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly wakesInFlight = new Map<string, Promise<void>>();
  // Kept in memory: a restart only delays giving up.
  private readonly unreadableSince = new Map<string, number>();
  private readonly viewers = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(private readonly options: PullRequestWatcherOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger.child({ module: "pull-request-watch" });
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
    await this.options.store.remove(watch.id);
    this.unreadableSince.delete(watch.id);
    return { number, url: watch.url, watching: false, wasWatching: true };
  }

  async disposeForAgent(agentId: string): Promise<void> {
    for (const watch of await this.options.store.removeForAgent(agentId)) {
      this.unreadableSince.delete(watch.id);
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
    let watches: PullRequestWatch[];
    try {
      watches = await this.options.store.list();
    } catch (error) {
      this.logger.error({ err: error }, "pull_request_watch.list_failed");
      return;
    }
    for (const watch of watches) {
      if (this.wakesInFlight.has(watch.id)) continue;
      try {
        await this.check(watch);
      } catch (error) {
        this.logger.warn({ err: error, watchId: watch.id }, "pull_request_watch.check_failed");
      }
    }
  }

  private async check(watch: PullRequestWatch): Promise<void> {
    const record = await this.options.agentStorage.get(watch.agentId);
    if (!record || record.archivedAt) {
      await this.options.store.remove(watch.id);
      return;
    }
    let reading: Reading;
    try {
      reading = await this.read(watch, await this.requireForge(watch.cwd));
    } catch (error) {
      await this.noteUnreadable(watch, error);
      return;
    }
    this.unreadableSince.delete(watch.id);
    if (reading.kind === "ended") {
      await this.options.store.remove(watch.id);
      return;
    }
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
      return;
    }
    this.wake(watch, message, { kind: "progress", next: report.next });
  }

  private async noteUnreadable(watch: PullRequestWatch, error: unknown): Promise<void> {
    const since = this.unreadableSince.get(watch.id) ?? this.now();
    this.unreadableSince.set(watch.id, since);
    this.logger.debug({ err: error, watchId: watch.id }, "pull_request_watch.read_failed");
    if (this.now() - since < PULL_REQUEST_UNREADABLE_LIMIT_MS) return;
    this.unreadableSince.delete(watch.id);
    await this.options.store.remove(watch.id);
    this.wake(
      watch,
      renderUnreadableWake({
        number: watch.number,
        url: watch.url,
        minutes: PULL_REQUEST_UNREADABLE_LIMIT_MS / 60_000,
      }),
      { kind: "final" },
    );
  }

  private wake(watch: PullRequestWatch, message: SystemMessage, outcome: WakeOutcome): void {
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
      await store.removeForAgent(watch.agentId);
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
      if (!isOpenState(summary.state)) return { kind: "ended" };
      throw new Error(`No status for pull request #${number} on ${watch.headRefName}`);
    }
    if (status.isMerged || !isOpenState(status.state)) return { kind: "ended" };
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
