import type {
  FormPreferences,
  RememberedBaseBranch,
  RememberedWorkspaceProject,
} from "@/create-agent-preferences/preferences";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-projects";
import type { BranchPickerDetail, PickerItem } from "../new-workspace-picker-item";
import { buildBranchPickerItems } from "../new-workspace-picker-item";

export function rememberedProjectKey(input: RememberedWorkspaceProject): string {
  return `${input.serverId}:${input.projectId}`;
}

export function toRememberedProject(
  project: HostProjectListItem | null,
  serverId: string,
): RememberedWorkspaceProject | null {
  if (!project) return null;
  const projectId = getHostProjectId(project, serverId);
  return projectId ? { serverId, projectId } : null;
}

// The remembered host moves to the front so host resolution, which walks
// `hosts` in order, lands on the host the project was last used from.
export function resolveRememberedProject(input: {
  remembered: RememberedWorkspaceProject | undefined;
  projects: readonly HostProjectListItem[];
  allServerIds: readonly string[];
}): HostProjectListItem | null {
  const { remembered, projects, allServerIds } = input;
  if (!remembered || !allServerIds.includes(remembered.serverId)) return null;
  const project = projects.find(
    (candidate) => getHostProjectId(candidate, remembered.serverId) === remembered.projectId,
  );
  if (!project) return null;
  const rememberedHost = project.hosts.find((host) => host.serverId === remembered.serverId);
  if (!rememberedHost || project.hosts[0] === rememberedHost) return project;
  return {
    ...project,
    hosts: [rememberedHost, ...project.hosts.filter((host) => host !== rememberedHost)],
  };
}

export function rememberedBaseBranchItem(input: {
  remembered: RememberedBaseBranch | undefined;
  branchDetails: readonly BranchPickerDetail[];
}): PickerItem | null {
  const { remembered, branchDetails } = input;
  if (!remembered) return null;
  return (
    buildBranchPickerItems(branchDetails).find(
      (item) => item.kind === "branch" && item.refName === remembered.refName,
    ) ?? null
  );
}

export function rememberNewWorkspaceSelection(input: {
  preferences: FormPreferences;
  project: RememberedWorkspaceProject | null;
  baseItem: PickerItem | null;
}): FormPreferences {
  const { preferences, project, baseItem } = input;
  if (!project) return preferences;
  const next: FormPreferences = { ...preferences, lastWorkspaceProject: project };
  if (baseItem?.kind === "branch") {
    next.baseBranchByProject = {
      ...preferences.baseBranchByProject,
      [rememberedProjectKey(project)]: { refName: baseItem.refName },
    };
  }
  return next;
}
