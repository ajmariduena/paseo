// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import { useNewWorkspaceProjectPicker } from "./project-picker";

function project(input: {
  viewKey: string;
  projectKey: string | null;
  projectId: string;
  projectName: string;
}): HostProjectListItem {
  return {
    ...input,
    projectKind: "git",
    iconWorkingDir: `/work/${input.projectId}`,
    hosts: [
      {
        serverId: "host",
        projectId: input.projectId,
        iconWorkingDir: `/work/${input.projectId}`,
        worktreeSupport: "supported",
      },
    ],
    workspaceKeys: [],
  };
}

describe("useNewWorkspaceProjectPicker", () => {
  it("preserves a manual choice when the routed project hydrates", () => {
    const routePlacement = project({
      viewKey: '["host","route-local"]',
      projectKey: null,
      projectId: "route-local",
      projectName: "Route project",
    });
    const hydratedRouteProject = project({
      viewKey: "remote:github.com/acme/route",
      projectKey: "remote:github.com/acme/route",
      projectId: "route-local",
      projectName: "Route project",
    });
    const manualProject = project({
      viewKey: "remote:github.com/acme/manual",
      projectKey: "remote:github.com/acme/manual",
      projectId: "manual-local",
      projectName: "Manual project",
    });
    const { result, rerender } = renderHook(
      ({ routeProject, projects }) =>
        useNewWorkspaceProjectPicker({
          selectedServerId: "host",
          projects,
          routeProject,
          routeProjectContextViewKey: routePlacement.viewKey,
          lastActiveProject: null,
          allowAllProjects: true,
        }),
      {
        initialProps: {
          routeProject: routePlacement,
          projects: [routePlacement, manualProject],
        },
      },
    );

    const manualOption = result.current.projectPickerOptions.find(
      (option) => option.label === manualProject.projectName,
    );
    expect(manualOption).toBeDefined();
    act(() => result.current.handleSelectProjectOption(manualOption!.id));
    expect(result.current.selectedProject).toEqual(manualProject);

    rerender({
      routeProject: hydratedRouteProject,
      projects: [hydratedRouteProject, manualProject],
    });

    expect(result.current.selectedProject).toEqual(manualProject);
  });

  it("starts in No project and lists it first under its localized label", () => {
    const repo = project({
      viewKey: "remote:github.com/acme/app",
      projectKey: "remote:github.com/acme/app",
      projectId: "app",
      projectName: "app",
    });
    const scratch: HostProjectListItem = {
      ...project({
        viewKey: '["host","scratch"]',
        projectKey: null,
        projectId: "scratch",
        projectName: "No project",
      }),
      projectKind: "non_git",
    };
    scratch.hosts = [{ ...scratch.hosts[0]!, worktreeSupport: "unsupported", isScratch: true }];
    const projects = [repo, scratch];
    const { result } = renderHook(() =>
      useNewWorkspaceProjectPicker({
        selectedServerId: "host",
        projects,
        routeProject: null,
        routeProjectContextViewKey: null,
        lastActiveProject: repo,
        allowAllProjects: true,
        scratchProjectLabel: "Sin proyecto",
      }),
    );

    expect(result.current.selectedProject).toEqual(scratch);
    expect(result.current.isScratchSelected).toBe(true);
    act(() => result.current.handleSelectProjectOption(result.current.projectPickerOptions[1]!.id));
    expect(result.current.selectedProject).toEqual(repo);
    expect(result.current.scratchOptionId).toBe(result.current.projectPickerOptions[0]!.id);

    expect(result.current.projectPickerOptions.map((option) => option.label)).toEqual([
      "Sin proyecto",
      "app",
    ]);
    act(() => result.current.handleSelectProjectOption(result.current.projectPickerOptions[0]!.id));
    expect(result.current.selectedProject).toEqual(scratch);
    expect(result.current.projectTriggerLabel).toBe("Sin proyecto");
  });
  it("keeps the remembered project's clone on another host instead of falling back to No project", () => {
    const rememberedOnPrimary: HostProjectListItem = {
      ...project({
        viewKey: '["primary","paseo-primary"]',
        projectKey: "remote:github.com/getpaseo/paseo",
        projectId: "paseo-primary",
        projectName: "Paseo",
      }),
    };
    rememberedOnPrimary.hosts = [{ ...rememberedOnPrimary.hosts[0]!, serverId: "primary" }];
    const cloneOnSecondary: HostProjectListItem = {
      ...project({
        viewKey: '["secondary","paseo-secondary"]',
        projectKey: "remote:github.com/getpaseo/paseo",
        projectId: "paseo-secondary",
        projectName: "Paseo",
      }),
    };
    cloneOnSecondary.hosts = [{ ...cloneOnSecondary.hosts[0]!, serverId: "secondary" }];
    const secondaryScratch: HostProjectListItem = {
      ...project({
        viewKey: '["secondary","scratch"]',
        projectKey: null,
        projectId: "scratch",
        projectName: "No project",
      }),
      projectKind: "non_git",
    };
    secondaryScratch.hosts = [
      {
        ...secondaryScratch.hosts[0]!,
        serverId: "secondary",
        worktreeSupport: "unsupported",
        isScratch: true,
      },
    ];
    const { result } = renderHook(() =>
      useNewWorkspaceProjectPicker({
        selectedServerId: "secondary",
        projects: [rememberedOnPrimary, cloneOnSecondary, secondaryScratch],
        routeProject: null,
        routeProjectContextViewKey: null,
        lastActiveProject: null,
        rememberedProject: rememberedOnPrimary,
        allowAllProjects: true,
      }),
    );

    expect(result.current.selectedProject).toEqual(cloneOnSecondary);
  });
});
