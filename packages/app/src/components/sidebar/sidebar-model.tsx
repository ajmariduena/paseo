import { useTranslation } from "react-i18next";
import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { createPendingSidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { usePendingWorkspaceCreationStore } from "@/stores/pending-workspace-creation";
import { PendingWorkspaceCreationReconciler } from "@/runtime/pending-workspace-creations";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  hasActiveSidebarLabelFilter,
  useSidebarViewStore,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { filterWorkspacesByLabels, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";
import {
  hasAuthoritativeWorkspaceLabelCatalog,
  useWorkspaceLabelProjection,
} from "@/workspace-labels";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /**
   * Every project the sidebar could show, before any filter narrows it.
   *
   * `projects` is the FILTERED list. A surface that offers a filter picker must read this one, or
   * narrowing the filter deletes the rows that would undo it.
   */
  allProjects: SidebarProjectEntry[];
  /** The project filter as it is actually being applied — see `resolveActiveProjectFilters`. */
  resolvedProjectFilters: readonly string[];
  hasProjectsBeforeFilter: boolean;
  groupMode: SidebarGroupMode;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);

export function SidebarModelProvider({
  active,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const list = useSidebarWorkspacesList({ enabled: active });
  const pendingCreations = usePendingWorkspaceCreationStore((state) => state.byKey);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const reconcileLabelFilter = useSidebarViewStore((state) => state.reconcileLabelFilter);
  const { hosts: labelHosts } = useWorkspaceLabelProjection();
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const pinnedWorkspaceOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const availableLabelNames = useMemo(
    () => labelHosts.flatMap((host) => host.labels.map((label) => label.name)),
    [labelHosts],
  );
  const hasAuthoritativeLabelCatalog = hasAuthoritativeWorkspaceLabelCatalog(labelHosts);
  useEffect(() => {
    if (!hasAuthoritativeLabelCatalog) return;
    reconcileLabelFilter(availableLabelNames);
  }, [availableLabelNames, hasAuthoritativeLabelCatalog, reconcileLabelFilter]);
  const hasActiveLabelFilter = hasActiveSidebarLabelFilter(labelFilter);
  const pendingProjection = useMemo(() => {
    const projects = [...list.projects];
    const placements = [...list.workspacePlacements];
    const entries = new Map<string, SidebarWorkspaceEntry>();
    const realKeys = new Set(placements.map((placement) => placement.workspaceKey));
    for (const creation of Object.values(pendingCreations)) {
      if (hostFilters.length > 0 && !hostFilters.includes(creation.serverId)) continue;
      const entry = createPendingSidebarWorkspaceEntry(creation);
      if (realKeys.has(entry.workspaceKey)) continue;
      const projectIndex = projects.findIndex((item) => item.viewKey === creation.projectViewKey);
      let project = projects[projectIndex];
      if (!project) {
        project = {
          viewKey: creation.projectViewKey,
          projectName: creation.projectName,
          projectKind: creation.projectKind,
          iconWorkingDir: creation.sourceDirectory,
          hosts: [
            {
              serverId: creation.serverId,
              projectId: creation.projectId,
              iconWorkingDir: creation.sourceDirectory,
              worktreeSupport: "unknown",
            },
          ],
          workspaces: [],
        };
        projects.push(project);
      } else {
        project = { ...project, workspaces: [...project.workspaces] };
        projects[projectIndex] = project;
      }
      const placement = {
        workspaceKey: entry.workspaceKey,
        serverId: entry.serverId,
        workspaceId: entry.workspaceId,
        projectViewKey: entry.projectViewKey,
        projectName: entry.projectName,
        projectRootPath: entry.projectRootPath,
        projectKind: entry.projectKind,
        workspaceKind: entry.workspaceKind,
        name: entry.name,
      };
      project.workspaces.unshift(placement);
      placements.push(placement);
      entries.set(entry.workspaceKey, entry);
    }
    return { projects, placements, entries };
  }, [hostFilters, list.projects, list.workspacePlacements, pendingCreations]);
  const resolvedProjectFilters = useMemo(
    () =>
      resolveActiveProjectFilters(
        projectFilters,
        new Set(pendingProjection.projects.map((project) => project.viewKey)),
      ),
    [projectFilters, pendingProjection.projects],
  );
  const hasActiveProjectFilter = resolvedProjectFilters.length > 0;
  // The project filter is deliberately absent from this gate. It reads `projectViewKey`, which
  // lives on the project and the placement, so it can narrow the project list without hydrating
  // anything; the label filter reads `labels`, which only exists on an entry. Hydration opens a
  // live session-store subscription over every workspace on every visible host, so widening this
  // for a filter that does not need it costs a retained-but-inactive sidebar real work.
  const needsWorkspaceEntries = groupMode !== "project" || hasActiveLabelFilter;
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    active !== false || needsWorkspaceEntries,
  );
  const projectedWorkspaceEntriesByKey = useMemo(
    () => new Map([...workspaceEntriesByKey, ...pendingProjection.entries]),
    [pendingProjection.entries, workspaceEntriesByKey],
  );
  const filteredWorkspaceEntriesByKey = useMemo(() => {
    const byProject = filterWorkspacesByProjects({
      workspaces: [...projectedWorkspaceEntriesByKey.values()],
      projectFilters: resolvedProjectFilters,
    });
    const filtered = filterWorkspacesByLabels({ workspaces: byProject, ...labelFilter });
    return new Map(filtered.map((workspace) => [workspace.workspaceKey, workspace]));
  }, [labelFilter, resolvedProjectFilters, projectedWorkspaceEntriesByKey]);
  const visibleWorkspaceKeys = useMemo(
    () => new Set(filteredWorkspaceEntriesByKey.keys()),
    [filteredWorkspaceEntriesByKey],
  );
  // The two filters prune differently on purpose. The project filter is a membership test on the
  // project itself, so a project you filtered TO survives even with no workspaces — it still owns
  // a header row you can create your first workspace under. The label filter can only ask about
  // workspaces, so a project it empties has nothing left to show.
  const filteredProjects = useMemo(() => {
    let projects = pendingProjection.projects;
    if (hasActiveProjectFilter) {
      const included = new Set(resolvedProjectFilters);
      projects = projects.filter((project) => included.has(project.viewKey));
    }
    if (hasActiveLabelFilter) {
      projects = projects.flatMap((project) => {
        const workspaces = project.workspaces.filter((workspace) =>
          visibleWorkspaceKeys.has(workspace.workspaceKey),
        );
        return workspaces.length > 0 ? [{ ...project, workspaces }] : [];
      });
    }
    return projects;
  }, [
    hasActiveLabelFilter,
    hasActiveProjectFilter,
    resolvedProjectFilters,
    pendingProjection.projects,
    visibleWorkspaceKeys,
  ]);
  const pinnedKeys = usePinnedSidebarKeys(filteredProjects);
  const projectNamesByViewKey = useMemo(
    () =>
      new Map(pendingProjection.projects.map((project) => [project.viewKey, project.projectName])),
    [pendingProjection.projects],
  );
  const projectionInput = useMemo(
    () => ({
      projects: filteredProjects,
      pinnedKeys,
      pinnedWorkspaceOrder,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      projectNamesByViewKey,
      groupMode,
      pinnedCollapsed,
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      t,
    }),
    [
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      groupMode,
      projectNamesByViewKey,
      filteredProjects,
      pinnedCollapsed,
      pinnedKeys,
      pinnedWorkspaceOrder,
      filteredWorkspaceEntriesByKey,
      t,
    ],
  );
  const projection = useMemo(() => buildSidebarProjection(projectionInput), [projectionInput]);
  const value = useMemo(
    () => ({
      ...list,
      workspacePlacements: pendingProjection.placements,
      projectNamesByViewKey,
      projects: filteredProjects,
      allProjects: pendingProjection.projects,
      resolvedProjectFilters,
      hasProjectsBeforeFilter: pendingProjection.projects.length > 0,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      groupMode,
      workspaceGroups: projection.workspaceGroups,
      projectIconTargets: projection.projectIconTargets,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel: projection.shortcutModel,
    }),
    [
      resolvedProjectFilters,
      collapsedProjectKeys,
      groupMode,
      list,
      pendingProjection,
      projectNamesByViewKey,
      filteredProjects,
      projection,
      toggleProjectCollapsed,
      filteredWorkspaceEntriesByKey,
    ],
  );

  return (
    <SidebarModelContext.Provider value={value}>
      <PendingWorkspaceCreationReconciler />
      {children}
    </SidebarModelContext.Provider>
  );
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
