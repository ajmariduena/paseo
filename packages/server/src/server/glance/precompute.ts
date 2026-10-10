import type pino from "pino";
import type { GlanceSummaryMessage, GlanceSummaryItem } from "@getpaseo/protocol/messages";
import type {
  AgentManagerEvent,
  AgentSubscriber,
  SubscribeOptions,
} from "../agent/agent-manager.js";
import type { AgentPermissionRequest, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentTimelineFetchOptions } from "../agent/agent-timeline-store-types.js";
import { glanceSummaryKey, normalizeGlanceText, type GlanceSummaryService } from "./service.js";

const TIMELINE_TAIL = 40;
const MAX_ITEMS = 20;

export type GlanceSummaryPush = GlanceSummaryMessage["payload"];

interface PrecomputeAgent {
  cwd: string;
  internal?: boolean;
  pendingPermissions: ReadonlyMap<string, AgentPermissionRequest>;
}

export interface GlancePrecomputeAgents {
  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void;
  getAgent(agentId: string): PrecomputeAgent | null;
  fetchTimeline(
    agentId: string,
    options: AgentTimelineFetchOptions,
  ): { rows: ReadonlyArray<{ item: AgentTimelineItem; seqStart: number }> };
}

export interface GlancePrecomputerOptions {
  agents: GlancePrecomputeAgents;
  service: Pick<GlanceSummaryService, "isGlassesMode" | "getCachedLine" | "summarize">;
  publish: (push: GlanceSummaryPush) => void;
  logger: pino.Logger;
}

/** Summarizes what the glasses will show as soon as it lands, so they read a cache instead of waiting. */
export class GlancePrecomputer {
  private unsubscribe: (() => void) | null = null;
  private readonly running = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();

  constructor(private readonly options: GlancePrecomputerOptions) {}

  start(): void {
    this.unsubscribe ??= this.options.agents.subscribe((event) => this.handleEvent(event), {
      replayState: false,
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async settled(agentId: string): Promise<void> {
    await this.running.get(agentId);
  }

  private handleEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_stream") return;
    if (event.event.type !== "turn_completed" && event.event.type !== "attention_required") return;
    if (!this.options.service.isGlassesMode()) return;
    this.schedule(event.agentId);
  }

  private schedule(agentId: string): void {
    if (this.running.has(agentId)) {
      this.dirty.add(agentId);
      return;
    }
    const run = (async () => {
      do {
        this.dirty.delete(agentId);
        await this.precompute(agentId);
      } while (this.dirty.has(agentId));
    })().finally(() => this.running.delete(agentId));
    this.running.set(agentId, run);
  }

  private async precompute(agentId: string): Promise<void> {
    try {
      const agent = this.options.agents.getAgent(agentId);
      // Internal agents include the summarizer's own runs; following them would loop.
      if (!agent || agent.internal) return;
      const sources = this.collect(agentId, agent).filter(
        (source) => this.options.service.getCachedLine(source.role, source.text) === undefined,
      );
      if (sources.length === 0) return;
      const lines = await this.options.service.summarize({ items: sources, cwd: agent.cwd });
      this.options.publish({
        agentId,
        items: sources.map((source, index) => ({
          id: source.id,
          role: source.role,
          line: lines[index]!.line,
          textHash: glanceSummaryKey(source.role, source.text),
        })),
      });
    } catch (error) {
      this.options.logger.warn({ err: error, agentId }, "Failed to precompute glance summaries");
    }
  }

  private collect(agentId: string, agent: PrecomputeAgent): GlanceSummaryItem[] {
    const { rows } = this.options.agents.fetchTimeline(agentId, {
      direction: "tail",
      limit: TIMELINE_TAIL,
    });
    const sources: GlanceSummaryItem[] = [];
    const seen = new Set<string>();
    const add = (item: GlanceSummaryItem) => {
      const key = glanceSummaryKey(item.role, item.text);
      if (!item.text || seen.has(key)) return;
      seen.add(key);
      sources.push(item);
    };
    for (const type of ["user_message", "assistant_message"] as const) {
      const row = rows.findLast((candidate) => candidate.item.type === type);
      if (row) add(timelineSource(row.item, row.seqStart));
    }
    for (const request of agent.pendingPermissions.values()) {
      add({
        id: `permission:${request.id}`,
        role: "assistant",
        text: normalizeGlanceText(permissionText(request)),
      });
    }
    return sources.slice(0, MAX_ITEMS);
  }
}

/** Mirrors the id glasses clients derive from a projected timeline entry. */
function timelineSource(item: AgentTimelineItem, seqStart: number): GlanceSummaryItem {
  const message = item as { messageId?: string; clientMessageId?: string; text?: string };
  return {
    id: message.messageId || message.clientMessageId || `seq:${seqStart}`,
    role: item.type === "user_message" ? "user" : "assistant",
    text: normalizeGlanceText(message.text ?? ""),
  };
}

function permissionText(request: AgentPermissionRequest): string {
  const input = request.input as Record<string, unknown> | undefined;
  const questions = Array.isArray(input?.questions)
    ? input.questions.flatMap((entry: unknown) => {
        const question = (entry as { question?: unknown } | null)?.question;
        return typeof question === "string" && question.trim() ? [question.trim()] : [];
      })
    : [];
  if (questions.length > 0) return questions.join(" ");
  if (request.kind === "plan" && typeof input?.plan === "string") return input.plan;
  return [request.title, request.description].filter(Boolean).join(": ") || request.name;
}
