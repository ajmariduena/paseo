import type {
  VoiceFleetAgent,
  VoiceFleetDigest,
  VoiceFleetProject,
  VoiceFleetSession,
  VoiceFleetWorkspace,
} from "@getpaseo/protocol/voice-fleet/types";
import { formatAge, formatDigestLine } from "../digest/agent-digest.js";
import { formatHostHealth } from "./host-health.js";

export interface FleetHost {
  /** Null for the host running the call. */
  serverId: string | null;
  label: string;
  online: boolean;
  lastSeenAt: string | null;
  supportsTools: boolean;
  digest: VoiceFleetDigest | null;
}

export type FleetTarget =
  | { kind: "agent"; ref: string; host: FleetHost; agent: VoiceFleetAgent }
  | { kind: "session"; ref: string; host: FleetHost; session: VoiceFleetSession }
  | { kind: "workspace"; ref: string; host: FleetHost; workspace: VoiceFleetWorkspace }
  | { kind: "project"; ref: string; host: FleetHost; project: VoiceFleetProject }
  | { kind: "host"; ref: string; host: FleetHost };

const AGENT_LIMIT = 28;
const SESSION_LIMIT = 24;
const WORKSPACE_LIMIT = 30;
const PROJECT_LIMIT = 30;
const LIVE_LINE_MAX = 330;

const STATUS_RANK: Record<string, number> = {
  waiting_permission: 0,
  failed: 1,
  working: 2,
  initializing: 2,
  finished_unreviewed: 3,
  idle: 4,
};

/**
 * One call's view of every host: short refs (a3, w2, p1, h2, s4) for the router model, and
 * the text both models read. Refs are stable for the view's life, so a plan made from it
 * stays valid until it runs.
 */
export class FleetView {
  readonly hosts: FleetHost[];
  private readonly targets = new Map<string, FleetTarget>();
  private readonly agents: Array<Extract<FleetTarget, { kind: "agent" }>> = [];
  private readonly sessions: Array<Extract<FleetTarget, { kind: "session" }>> = [];
  private readonly workspaces: Array<Extract<FleetTarget, { kind: "workspace" }>> = [];
  private readonly projects: Array<Extract<FleetTarget, { kind: "project" }>> = [];

  constructor(
    hosts: FleetHost[],
    private readonly now: number = Date.now(),
  ) {
    this.hosts = hosts;
    hosts.forEach((host, index) => {
      const ref = `h${index + 1}`;
      this.targets.set(ref, { kind: "host", ref, host });
    });
    const agentEntries = hosts
      .flatMap((host) => (host.digest?.agents ?? []).map((agent) => ({ host, agent })))
      .sort(
        (left, right) =>
          (STATUS_RANK[left.agent.status] ?? 5) - (STATUS_RANK[right.agent.status] ?? 5) ||
          Date.parse(right.agent.updatedAt) - Date.parse(left.agent.updatedAt),
      )
      .slice(0, AGENT_LIMIT);
    for (const [index, entry] of agentEntries.entries()) {
      const target = { kind: "agent" as const, ref: `a${index + 1}`, ...entry };
      this.agents.push(target);
      this.targets.set(target.ref, target);
    }
    const shownAgents = new Set(
      agentEntries.map((entry) => `${entry.host.serverId ?? ""}\u0000${entry.agent.agentId}`),
    );
    const sessionEntries = hosts
      .flatMap((host) => (host.digest?.sessions ?? []).map((session) => ({ host, session })))
      .filter(
        (entry) => !shownAgents.has(`${entry.host.serverId ?? ""}\u0000${entry.session.agentId}`),
      )
      .sort(
        (left, right) =>
          Date.parse(right.session.lastActivityAt) - Date.parse(left.session.lastActivityAt),
      )
      .slice(0, SESSION_LIMIT);
    for (const [index, entry] of sessionEntries.entries()) {
      const target = { kind: "session" as const, ref: `s${index + 1}`, ...entry };
      this.sessions.push(target);
      this.targets.set(target.ref, target);
    }
    const busyWorkspaces = new Set(
      agentEntries.map((entry) => entry.agent.workspaceId).filter(Boolean),
    );
    const workspaceEntries = hosts
      .flatMap((host) => (host.digest?.workspaces ?? []).map((workspace) => ({ host, workspace })))
      .sort(
        (left, right) =>
          Number(busyWorkspaces.has(right.workspace.workspaceId)) -
          Number(busyWorkspaces.has(left.workspace.workspaceId)),
      )
      .slice(0, WORKSPACE_LIMIT);
    for (const [index, entry] of workspaceEntries.entries()) {
      const target = { kind: "workspace" as const, ref: `w${index + 1}`, ...entry };
      this.workspaces.push(target);
      this.targets.set(target.ref, target);
    }
    const projectEntries = hosts
      .flatMap((host) => (host.digest?.projects ?? []).map((project) => ({ host, project })))
      .slice(0, PROJECT_LIMIT);
    for (const [index, entry] of projectEntries.entries()) {
      const target = { kind: "project" as const, ref: `p${index + 1}`, ...entry };
      this.projects.push(target);
      this.targets.set(target.ref, target);
    }
  }

  get isMultiHost(): boolean {
    return this.hosts.length > 1;
  }

  get localHost(): FleetHost | null {
    return this.hosts.find((host) => host.serverId === null) ?? null;
  }

  /** A ref, an id, or a name the model wrote instead of a ref, when exactly one thing matches. */
  resolve(value: string): FleetTarget | null {
    const key = value.trim();
    const direct = this.targets.get(key.toLowerCase());
    if (direct) return direct;
    const byId = [...this.targets.values()].filter((target) => targetId(target) === key);
    // The same id on two hosts (a copied PASEO_HOME) can't say which one is meant.
    if (byId.length > 0) return byId.length === 1 ? (byId[0] ?? null) : null;
    const needle = normalizeName(key);
    if (needle.length < 3) return null;
    const matches = [...this.targets.values()].filter((target) =>
      normalizeName(targetName(target)).includes(needle),
    );
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  findSessions(query: string): FleetTarget[] {
    const words = normalizeName(query)
      .split(" ")
      .filter((word) => word.length >= 3);
    if (words.length === 0) return [];
    return [...this.targets.values()]
      .filter((target) => target.kind !== "host")
      .map((target) => {
        const haystack = normalizeName(
          [
            targetName(target),
            target.kind === "agent" ? `${target.agent.workspace} ${target.agent.task ?? ""}` : "",
            target.kind === "session" ? target.session.workspace : "",
          ].join(" "),
        );
        return { target, score: words.filter((word) => haystack.includes(word)).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 6)
      .map((entry) => entry.target);
  }

  /** How a target is said aloud: no ref, the host only when there are several. */
  speakTarget(target: FleetTarget): string {
    const host = this.isMultiHost ? ` on ${target.host.label}` : "";
    switch (target.kind) {
      case "agent":
        return `the agent "${target.agent.title}" (workspace ${target.agent.workspace})${host}`;
      case "session":
        return `the session "${target.session.title}" (workspace ${target.session.workspace})${host}`;
      case "workspace":
        return `the workspace "${target.workspace.title}"${host}`;
      case "project":
        return `the project ${target.project.name}${host}`;
      case "host":
        return target.host.label;
    }
  }

  describeTarget(target: FleetTarget): string {
    const host = this.isMultiHost ? ` on ${target.host.label}` : "";
    switch (target.kind) {
      case "agent":
        return `${target.ref} "${target.agent.title}" in ${target.agent.workspace}${host}`;
      case "session":
        return `${target.ref} "${target.session.title}" in ${target.session.workspace}${host} (idle)`;
      case "workspace":
        return `${target.ref} workspace "${target.workspace.title}"${host}`;
      case "project":
        return `${target.ref} project ${target.project.name}${host}`;
      case "host":
        return `${target.ref} ${target.host.label}`;
    }
  }

  /** Everything the router model needs to pick a tool and a target. */
  routerContext(): string {
    const lines: string[] = [];
    lines.push("Hosts:");
    for (const [ref, target] of this.targets) {
      if (target.kind !== "host") continue;
      const health = target.host.digest?.health;
      lines.push(
        `${ref} ${target.host.label} — ${describeHostState(target.host, this.now)}${health ? `; ${formatHostHealth("load", health)}` : ""}`,
      );
    }
    lines.push("Projects (where new work can start):");
    if (this.projects.length === 0) lines.push("- none");
    for (const target of this.projects) {
      lines.push(
        `${target.ref} ${target.project.name}${this.hostSuffix(target.host)} — ${target.project.rootPath}`,
      );
    }
    lines.push("Workspaces:");
    if (this.workspaces.length === 0) lines.push("- none");
    for (const target of this.workspaces) {
      const { workspace } = target;
      const project = this.projects.find(
        (entry) => entry.host === target.host && entry.project.projectId === workspace.projectId,
      );
      lines.push(
        `${target.ref} "${workspace.title}"${this.hostSuffix(target.host)} — ${workspace.kind}${workspace.branch ? `, branch ${workspace.branch}` : ""}${project ? `, project ${project.ref}` : ""}`,
      );
    }
    lines.push("Agents:");
    if (this.agents.length === 0) lines.push("- none");
    for (const target of this.agents) {
      const workspace = this.workspaces.find(
        (entry) =>
          entry.host === target.host && entry.workspace.workspaceId === target.agent.workspaceId,
      );
      const line = formatDigestLine(target.agent, {
        host: this.isMultiHost ? target.host.label : undefined,
      });
      lines.push(`${target.ref}${workspace ? ` (${workspace.ref})` : ""} ${line}`);
    }
    if (this.sessions.length > 0) {
      lines.push("Older sessions (idle; a message revives them):");
      for (const target of this.sessions) {
        lines.push(
          `${target.ref} "${target.session.title}" in ${target.session.workspace}${this.hostSuffix(target.host)}, last active ${target.session.lastActivityAt.slice(0, 10)}`,
        );
      }
    }
    return lines.join("\n");
  }

  /**
   * One line per agent for GPT-Live, keyed so a caller can send only what changed. The
   * signature leaves out the ticking age, so time passing alone is not a change.
   */
  liveLines(): Map<string, { line: string; signature: string; title: string }> {
    const lines = new Map<string, { line: string; signature: string; title: string }>();
    const host = (target: (typeof this.agents)[number]) =>
      this.isMultiHost ? target.host.label : undefined;
    for (const target of this.agents) {
      const key = `${target.host.serverId ?? "local"}:${target.agent.agentId}`;
      const line = formatDigestLine(target.agent, { host: host(target) });
      lines.set(key, {
        title: target.agent.title,
        line: line.length > LIVE_LINE_MAX ? `${line.slice(0, LIVE_LINE_MAX - 1)}…` : line,
        signature: formatDigestLine(
          { ...target.agent, statusForMs: undefined },
          { host: host(target) },
        ),
      });
    }
    return lines;
  }

  /**
   * Each computer's load, and which are offline, so GPT-Live answers "how is the mini" itself
   * and never presents an offline host's state as current.
   */
  liveHostNotes(): Array<{ line: string; signature: string }> {
    return this.hosts.map((host) => {
      if (!host.online) {
        const since = host.lastSeenAt
          ? ` since ${formatAge(Math.max(0, this.now - Date.parse(host.lastSeenAt)))} ago`
          : "";
        const rest = "; its agents' state is from then, and actions on it are not possible now.";
        // The signature leaves out the ticking age: only going offline is news.
        return {
          line: `${host.label} is offline${since}${rest}`,
          signature: `${host.label} offline`,
        };
      }
      const health = host.digest?.health;
      const label = this.isMultiHost ? host.label : `This computer (${host.label})`;
      const line = health ? formatHostHealth(label, health, { coarse: true }) : `${label}: online`;
      return { line, signature: line };
    });
  }

  private hostSuffix(host: FleetHost): string {
    return this.isMultiHost ? ` [${host.label}]` : "";
  }
}

function describeHostState(host: FleetHost, now: number): string {
  if (host.serverId === null) return "the host running this call";
  if (!host.online) {
    const since = host.lastSeenAt
      ? `, last seen ${formatAge(now - Date.parse(host.lastSeenAt))} ago`
      : "";
    return `offline${since}; no actions possible`;
  }
  return host.supportsTools ? "online" : "online, read-only (older Paseo)";
}

function targetId(target: FleetTarget): string | null {
  switch (target.kind) {
    case "agent":
      return target.agent.agentId;
    case "session":
      return target.session.agentId;
    case "workspace":
      return target.workspace.workspaceId;
    case "project":
      return target.project.projectId;
    case "host":
      return target.host.serverId;
  }
}

function targetName(target: FleetTarget): string {
  switch (target.kind) {
    case "agent":
      return target.agent.title;
    case "session":
      return target.session.title;
    case "workspace":
      return target.workspace.title;
    case "project":
      return target.project.name;
    case "host":
      return target.host.label;
  }
}

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
