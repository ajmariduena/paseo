import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { ProjectHostEntry, WorkspaceSummary } from "@/utils/projects";

type ShareWorkspaceSource = Pick<
  WorkspaceSummary,
  "id" | "name" | "title" | "currentBranch" | "archivingAt"
>;

interface ShareProjectHostSource extends Pick<
  ProjectHostEntry,
  "serverId" | "projectName" | "projectCustomName"
> {
  workspaces: readonly ShareWorkspaceSource[];
}

interface ShareProjectSource {
  hosts: readonly ShareProjectHostSource[];
}

type ShareAgentSource = Pick<
  AgentDirectoryEntry,
  "id" | "serverId" | "workspaceId" | "title" | "lastActivityAt" | "archivedAt"
>;

export interface ShareWorkspaceOption {
  workspaceId: string;
  title: string;
  subtitle: string;
}

export interface ShareAgentOption {
  agentId: string;
  title: string | null;
  lastActivityAt: Date;
}

function joinParts(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function matchesQuery(option: ShareWorkspaceOption, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    option.title.toLowerCase().includes(normalized) ||
    option.subtitle.toLowerCase().includes(normalized)
  );
}

function compareByTitle(left: ShareWorkspaceOption, right: ShareWorkspaceOption): number {
  const titleDelta = left.title.localeCompare(right.title, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return titleDelta || left.subtitle.localeCompare(right.subtitle);
}

/** The workspace the user was last in leads the list; the rest sort by title. */
export function buildShareWorkspaceOptions(input: {
  projects: readonly ShareProjectSource[];
  serverId: string;
  query: string;
  lastWorkspaceId: string | null;
}): ShareWorkspaceOption[] {
  const options: ShareWorkspaceOption[] = [];
  for (const project of input.projects) {
    for (const host of project.hosts) {
      if (host.serverId !== input.serverId) {
        continue;
      }
      const projectName = host.projectCustomName || host.projectName;
      for (const workspace of host.workspaces) {
        if (workspace.archivingAt) {
          continue;
        }
        options.push({
          workspaceId: workspace.id,
          title: workspace.title ?? workspace.name,
          subtitle: joinParts([projectName, workspace.currentBranch]),
        });
      }
    }
  }
  const matching = options.filter((option) => matchesQuery(option, input.query));
  matching.sort(compareByTitle);
  const lastIndex = matching.findIndex((option) => option.workspaceId === input.lastWorkspaceId);
  if (lastIndex > 0) {
    const [last] = matching.splice(lastIndex, 1);
    matching.unshift(last);
  }
  return matching;
}

export function buildShareAgentOptions(input: {
  agents: readonly ShareAgentSource[];
  serverId: string;
  workspaceId: string;
}): ShareAgentOption[] {
  return input.agents
    .filter(
      (agent) =>
        agent.serverId === input.serverId &&
        agent.workspaceId === input.workspaceId &&
        !agent.archivedAt,
    )
    .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime())
    .map((agent) => ({
      agentId: agent.id,
      title: agent.title,
      lastActivityAt: agent.lastActivityAt,
    }));
}
