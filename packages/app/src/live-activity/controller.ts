import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { LiveActivityNative } from "./native-types";
import { hasActiveWork, summarizeAgents, type LiveActivityLabels } from "./summary";

// The app stops updating once iOS suspends it, so the activity marks itself stale instead of
// showing old counts as current. Foreground updates keep pushing this out.
const STALE_AFTER_SECONDS = 15 * 60;
const REFRESH_AFTER_MS = 5 * 60 * 1000;
const DISMISS_AFTER_SECONDS = 10 * 60;

export interface AgentsLiveActivityDeps {
  native: LiveActivityNative;
  title: string;
  labels: () => LiveActivityLabels;
  workspaceName?: (agent: AgentDirectoryEntry) => string | null;
  isForeground: () => boolean;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/** Starts the activity when agents start working, keeps it current, ends it when work is done. */
export class AgentsLiveActivity {
  private since: number | null = null;
  private readonly runningSince = new Map<string, number>();
  private lastState: string | null = null;
  private lastPushedAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: AgentsLiveActivityDeps) {
    this.now = deps.now ?? Date.now;
    if (deps.native.isRunning()) this.enqueue(() => deps.native.end("", 0));
  }

  sync(agents: readonly AgentDirectoryEntry[]): void {
    const now = this.now();
    this.trackRunning(agents, now);
    const content = summarizeAgents({
      agents,
      since: this.since ?? now,
      runningSince: this.runningSince,
      labels: this.deps.labels(),
      workspaceName: this.deps.workspaceName,
    });
    const { native } = this.deps;

    if (this.since === null) {
      if (!content || !hasActiveWork(content)) return;
      if (!this.deps.isForeground() || !native.isEnabled()) return;
      this.since = now;
      const state = this.remember(content, now);
      this.enqueue(() => native.start(this.deps.title, state, STALE_AFTER_SECONDS));
      return;
    }

    if (!content || !hasActiveWork(content)) {
      this.since = null;
      this.lastState = null;
      const state = content ? JSON.stringify(content) : "";
      this.enqueue(() => native.end(state, content ? DISMISS_AFTER_SECONDS : 0));
      return;
    }

    const state = JSON.stringify(content);
    if (state === this.lastState && now - this.lastPushedAt < REFRESH_AFTER_MS) return;
    this.remember(content, now);
    this.enqueue(() => native.update(state, STALE_AFTER_SECONDS));
  }

  private remember(content: object, now: number): string {
    const state = JSON.stringify(content);
    this.lastState = state;
    this.lastPushedAt = now;
    return state;
  }

  private trackRunning(agents: readonly AgentDirectoryEntry[], now: number): void {
    const running = new Set<string>();
    for (const agent of agents) {
      if (agent.status !== "running" || agent.archivedAt) continue;
      const key = `${agent.serverId}:${agent.id}`;
      running.add(key);
      if (!this.runningSince.has(key)) this.runningSince.set(key, now);
    }
    for (const key of this.runningSince.keys()) {
      if (!running.has(key)) this.runningSince.delete(key);
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => this.deps.onError?.(error));
  }
}
