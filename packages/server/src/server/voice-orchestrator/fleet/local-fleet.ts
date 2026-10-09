import { basename } from "node:path";
import type pino from "pino";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import type {
  VoiceFleetAgent,
  VoiceFleetDigest,
  VoiceFleetHostHealth,
  VoiceFleetProject,
  VoiceFleetSession,
  VoiceFleetWorkspace,
} from "@getpaseo/protocol/voice-fleet/types";
import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import type { AgentManager, ManagedAgent } from "../../agent/agent-manager.js";
import { summarizeHostHealth } from "./host-health.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";
import { buildAgentDigest } from "../digest/agent-digest.js";
import type { DigestSummarizer } from "../digest/digest-summarizer.js";
import { speakableClip } from "../speakable.js";

const AGENT_LIMIT = 16;
const AGENT_RECENT_MS = 12 * 60 * 60 * 1000;
const SESSION_LIMIT = 30;
const SESSION_RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const WORKSPACE_LIMIT = 40;
const PROJECT_LIMIT = 30;
const HEALTH_REFRESH_MS = 5_000;

export interface LocalFleetOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: WorkspaceRegistry | null;
  projectRegistry: ProjectRegistry | null;
  /** Agents the call itself owns (the orchestrator) never show up. */
  isHidden: (agentId: string) => boolean;
  isUnheard: (agentId: string) => boolean;
  summarizer: DigestSummarizer | null;
  hostMetrics: (() => Promise<HostMetricsSnapshot>) | null;
  logger: pino.Logger;
}

/** This host's fleet as a voice call sees it: agents with digests, places to start work. */
export class LocalFleet {
  private health: VoiceFleetHostHealth | null = null;
  private healthAt = 0;
  private healthRefresh: Promise<void> | null = null;

  constructor(private readonly options: LocalFleetOptions) {}

  /**
   * The metrics sampler takes a few hundred milliseconds to start cold, so a digest never
   * waits for it: it serves the last reading and refreshes in the background.
   */
  refreshHealth(): void {
    const { hostMetrics } = this.options;
    if (!hostMetrics || this.healthRefresh || Date.now() - this.healthAt < HEALTH_REFRESH_MS)
      return;
    this.healthRefresh = (async () => {
      try {
        this.health = summarizeHostHealth(await hostMetrics());
        this.healthAt = Date.now();
      } catch (error) {
        this.options.logger.debug({ err: error }, "Host health sample failed");
      } finally {
        this.healthRefresh = null;
      }
    })();
  }

  /** The agents a call cares about now, most urgent first. */
  listAgents(): ManagedAgent[] {
    const now = Date.now();
    return this.options.agentManager
      .listAgents()
      .filter(
        (agent) =>
          !this.options.isHidden(agent.id) &&
          !agent.internal &&
          agent.lifecycle !== "closed" &&
          !isDelegatedAgent(agent) &&
          (agent.lifecycle === "running" ||
            agent.attention.requiresAttention ||
            agent.pendingPermissions.size > 0 ||
            now - agent.updatedAt.getTime() < AGENT_RECENT_MS),
      )
      .sort((left, right) => rank(left) - rank(right))
      .slice(0, AGENT_LIMIT);
  }

  async digest(): Promise<VoiceFleetDigest> {
    this.refreshHealth();
    const [workspaceRecords, projectRecords] = await Promise.all([
      this.options.workspaceRegistry?.list().catch(() => []) ?? Promise.resolve([]),
      this.options.projectRegistry?.list().catch(() => []) ?? Promise.resolve([]),
    ]);
    const workspaceTitles = new Map(
      workspaceRecords.map((record) => [record.workspaceId, record.title ?? record.displayName]),
    );
    const agents = this.listAgents();
    const agentDigests = agents.map((agent) => this.digestAgent(agent, workspaceTitles));
    const busy = new Set(agents.map((agent) => agent.workspaceId).filter(Boolean));
    const workspaces: VoiceFleetWorkspace[] = workspaceRecords
      .filter((record) => !record.archivedAt)
      .sort(
        (left, right) =>
          Number(busy.has(right.workspaceId)) - Number(busy.has(left.workspaceId)) ||
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )
      .slice(0, WORKSPACE_LIMIT)
      .map((record) => ({
        workspaceId: record.workspaceId,
        title: record.title ?? record.displayName,
        projectId: record.projectId,
        kind: record.kind,
        branch: record.branch,
        cwd: record.cwd,
      }));
    const projects: VoiceFleetProject[] = projectRecords
      .filter((record) => !record.archivedAt)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, PROJECT_LIMIT)
      .map((record) => ({
        projectId: record.projectId,
        name: record.customName ?? record.displayName,
        rootPath: record.rootPath,
      }));
    return {
      generatedAt: new Date().toISOString(),
      health: this.health,
      agents: agentDigests,
      workspaces,
      projects,
      sessions: await this.listSessions(new Set(agents.map((agent) => agent.id)), workspaceTitles),
    };
  }

  /** One agent's digest, with its summary when the summarizer has a current one. */
  digestAgent(agent: ManagedAgent, workspaceTitles?: Map<string, string>): VoiceFleetAgent {
    const { agentManager, summarizer } = this.options;
    const timeline = agentManager.getTimeline(agent.id);
    const base = buildAgentDigest({
      agent: {
        id: agent.id,
        title: agent.config.title?.trim() || "Untitled agent",
        provider: agent.provider,
        workspaceId: agent.workspaceId ?? null,
        workspace:
          (agent.workspaceId ? workspaceTitles?.get(agent.workspaceId) : undefined) ??
          basename(agent.cwd),
        projectId: null,
        lifecycle: agent.lifecycle,
        pendingPermissions: [...agent.pendingPermissions.values()],
        lastError: agent.lastError ?? null,
        finishedUnreviewed:
          agent.attention.requiresAttention && agent.attention.attentionReason === "finished",
        activeTurnStartedAt: agent.activeTurnStartedAt,
        updatedAt: agent.updatedAt,
        unheard: this.options.isUnheard(agent.id),
      },
      timeline,
      now: Date.now(),
    });
    if (!summarizer) return base;
    summarizer.refresh({
      agentId: agent.id,
      title: base.title,
      workspace: base.workspace,
      status: base.status,
      blocker: base.blocker ?? null,
      timeline,
    });
    return { ...base, summary: summarizer.peek(agent.id, base.status) };
  }

  /** Waits briefly for a fresh summary of an agent that just settled, for its notice. */
  async settledSummary(agent: ManagedAgent, timeoutMs: number): Promise<string | null> {
    const { summarizer } = this.options;
    if (!summarizer) return null;
    const digest = this.digestAgent(agent);
    return summarizer.ensure(
      {
        agentId: agent.id,
        title: digest.title,
        workspace: digest.workspace,
        status: digest.status,
        blocker: digest.blocker ?? null,
        timeline: this.options.agentManager.getTimeline(agent.id),
      },
      timeoutMs,
    );
  }

  private async listSessions(
    shown: Set<string>,
    workspaceTitles: Map<string, string>,
  ): Promise<VoiceFleetSession[]> {
    const now = Date.now();
    const records = await this.options.agentStorage.list().catch(() => []);
    return records
      .filter(
        (record) =>
          !record.internal &&
          !record.archivedAt &&
          !shown.has(record.id) &&
          !this.options.isHidden(record.id) &&
          now - Date.parse(record.lastActivityAt ?? record.updatedAt) < SESSION_RECENT_MS,
      )
      .sort(
        (left, right) =>
          Date.parse(right.lastActivityAt ?? right.updatedAt) -
          Date.parse(left.lastActivityAt ?? left.updatedAt),
      )
      .slice(0, SESSION_LIMIT)
      .map((record) => ({
        agentId: record.id,
        title: speakableClip(record.title?.trim() || "Untitled agent", 80),
        workspace:
          (record.workspaceId ? workspaceTitles.get(record.workspaceId) : undefined) ??
          basename(record.cwd),
        lastActivityAt: record.lastActivityAt ?? record.updatedAt,
      }));
  }
}

function rank(agent: ManagedAgent): number {
  if (agent.pendingPermissions.size > 0) return 0;
  if (agent.lifecycle === "error") return 1;
  if (agent.attention.requiresAttention) return 2;
  if (agent.lifecycle === "running") return 3;
  return 4;
}
