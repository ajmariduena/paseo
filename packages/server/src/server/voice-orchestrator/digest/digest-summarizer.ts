import type pino from "pino";
import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import type { FastLlm } from "../fast-brain/fast-brain.js";
import { describeLanguage } from "../prompt.js";
import { condenseTurn } from "./agent-digest.js";

interface CachedSummary {
  text: string;
  status: string;
  timelineLength: number;
  at: number;
}

interface SummaryRequest {
  agentId: string;
  title: string;
  workspace: string;
  status: string;
  blocker: string | null;
  timeline: readonly AgentTimelineItem[];
}

// While an agent runs, one fresh summary a minute is enough for a status question.
const RUNNING_REFRESH_MS = 60_000;
const HOURLY_CAP = 240;
const LOG_LINES = 40;
const SETTLED_STATUSES = new Set(["finished_unreviewed", "idle", "failed", "waiting_permission"]);

const SYSTEM_PROMPT = `You summarize a coding agent's work for a voice assistant that tells the user over a phone call. Use only facts from the log. Write at most two short sentences (40 words), no markdown, file paths, ids, code or URLs; name a file only when it matters. Say concrete things: what changed, what passed or failed, what it is waiting for, what is left. Never say "it is working" without saying on what. Write about the agent in the third person ("quitó", "abrió el PR"), never as "I", even when its own messages do. Keep the technical words developers say as they are (PR, merge, tests, commit, deploy) instead of translating them.`;

/**
 * Model-written status lines for agents someone is watching: refreshed when an agent settles
 * and at most once a minute while it runs. Without an observer nothing is spent.
 */
export class DigestSummarizer {
  private readonly cache = new Map<string, CachedSummary>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private observedUntil = 0;
  private watching = false;
  private hourStartedAt = Date.now();
  private spentThisHour = 0;

  constructor(
    private readonly options: {
      llm: FastLlm;
      language: () => string | null;
      logger: pino.Logger;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** False while no fast model is set up; summaries wait for one. */
  get enabled(): boolean {
    return this.options.llm.available;
  }

  /** A call runs on this host: summaries may run until it ends. */
  setWatching(watching: boolean): void {
    this.watching = watching;
  }

  /** A call on another host asked for this host's fleet: summaries may run for a while. */
  observe(forMs: number): void {
    this.observedUntil = Math.max(this.observedUntil, this.now() + forMs);
  }

  /** The current summary when it still describes the agent's status. */
  peek(agentId: string, status: string): string | null {
    const cached = this.cache.get(agentId);
    if (!cached || cached.status !== status) return null;
    return cached.text;
  }

  /** Starts a summary when the agent changed enough since the last one. Never waits. */
  refresh(request: SummaryRequest): void {
    if (!this.shouldRefresh(request)) return;
    void this.summarize(request);
  }

  /** The summary for a settled agent, waiting up to `timeoutMs` for a fresh one. */
  async ensure(request: SummaryRequest, timeoutMs: number): Promise<string | null> {
    const current = this.cache.get(request.agentId);
    if (
      current &&
      current.status === request.status &&
      current.timelineLength === request.timeline.length
    ) {
      return current.text;
    }
    if (!this.withinBudget()) return this.peek(request.agentId, request.status);
    const pending = this.summarize(request);
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs).unref?.();
    });
    return (await Promise.race([pending, timeout])) ?? this.peek(request.agentId, request.status);
  }

  forget(agentId: string): void {
    this.cache.delete(agentId);
  }

  private shouldRefresh(request: SummaryRequest): boolean {
    if (!this.watching && this.now() > this.observedUntil) return false;
    if (this.inFlight.has(request.agentId)) return false;
    const cached = this.cache.get(request.agentId);
    if (
      cached &&
      cached.timelineLength === request.timeline.length &&
      cached.status === request.status
    ) {
      return false;
    }
    const settled = SETTLED_STATUSES.has(request.status);
    if (!settled && cached && this.now() - cached.at < RUNNING_REFRESH_MS) return false;
    if (request.status === "working" && request.timeline.length < 3) return false;
    return this.withinBudget();
  }

  private withinBudget(): boolean {
    const now = this.now();
    if (now - this.hourStartedAt > 3_600_000) {
      this.hourStartedAt = now;
      this.spentThisHour = 0;
    }
    return this.spentThisHour < HOURLY_CAP;
  }

  private summarize(request: SummaryRequest): Promise<string | null> {
    if (!this.enabled) return Promise.resolve(null);
    const existing = this.inFlight.get(request.agentId);
    if (existing) return existing;
    this.spentThisHour += 1;
    const run = this.callModel(request)
      .then((text) => {
        if (text) {
          this.cache.set(request.agentId, {
            text,
            status: request.status,
            timelineLength: request.timeline.length,
            at: this.now(),
          });
        }
        return text;
      })
      .catch((error: unknown) => {
        this.options.logger.debug({ err: error, agentId: request.agentId }, "Agent summary failed");
        return null;
      })
      .finally(() => this.inFlight.delete(request.agentId));
    this.inFlight.set(request.agentId, run);
    return run;
  }

  private async callModel(request: SummaryRequest): Promise<string | null> {
    const { request: task, lines, finalMessage } = condenseTurn(request.timeline, LOG_LINES);
    if (lines.length === 0 && !finalMessage) return null;
    const language = this.options.language();
    const ask = askFor(request.status);
    const completion = await this.options.llm.complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Agent "${request.title}" in workspace ${request.workspace}. Status: ${request.status.replace(/_/g, " ")}.`,
            request.blocker ? `Blocked: ${request.blocker}` : null,
            task ? `The user's request: ${task.slice(0, 1200)}` : null,
            "Log, oldest first:",
            ...lines.map((line) => `- ${line}`),
            finalMessage && SETTLED_STATUSES.has(request.status)
              ? `Final message: ${finalMessage.slice(-2500)}`
              : null,
            `${ask} Write in ${language ? describeLanguage(language) : "English"}.`,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        },
      ],
      maxTokens: 160,
      temperature: 0.2,
      timeoutMs: 6_000,
    });
    const text = completion.content?.replace(/\s+/g, " ").trim();
    return text ? text : null;
  }
}

function askFor(status: string): string {
  switch (status) {
    case "working":
      return "Say what it is doing now and how far it got.";
    case "waiting_permission":
      return "Say what it was doing and exactly what it is asking permission for.";
    case "failed":
      return "Say what it was doing and why it failed.";
    default:
      return "Say what it did and the outcome, including anything left for the user.";
  }
}
