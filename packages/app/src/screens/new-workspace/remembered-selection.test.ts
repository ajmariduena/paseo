import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { PickerItem } from "../new-workspace-picker-item";
import {
  rememberNewWorkspaceSelection,
  rememberedBaseBranchItem,
  resolveRememberedProject,
  toRememberedProject,
} from "./remembered-selection";

function host(serverId: string, projectId: string) {
  return {
    serverId,
    projectId,
    iconWorkingDir: `/work/${projectId}`,
    worktreeSupport: "supported" as const,
  };
}

function project(projectKey: string, hosts = [host("a", projectKey)]): HostProjectListItem {
  return {
    viewKey: `view:${projectKey}`,
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: `/work/${projectKey}`,
    hosts,
    workspaceKeys: [],
  };
}

const branch = (refName: string): PickerItem => ({
  kind: "branch",
  name: refName,
  refName,
  accessibilityLabel: refName,
});

describe("resolveRememberedProject", () => {
  it("finds the remembered project on its host", () => {
    const paseo = project("paseo");
    expect(
      resolveRememberedProject({
        remembered: { serverId: "a", projectId: "paseo" },
        projects: [project("other"), paseo],
        allServerIds: ["a"],
      }),
    ).toBe(paseo);
  });

  it("puts the remembered host first for multi-host projects", () => {
    const shared = project("shared", [host("a", "shared-a"), host("b", "shared-b")]);
    const resolved = resolveRememberedProject({
      remembered: { serverId: "b", projectId: "shared-b" },
      projects: [shared],
      allServerIds: ["a", "b"],
    });
    expect(resolved?.hosts.map((h) => h.serverId)).toEqual(["b", "a"]);
    expect(resolved?.viewKey).toBe(shared.viewKey);
  });

  it("ignores projects that are gone or on unknown hosts", () => {
    const projects = [project("paseo")];
    expect(
      resolveRememberedProject({
        remembered: { serverId: "a", projectId: "deleted" },
        projects,
        allServerIds: ["a"],
      }),
    ).toBeNull();
    expect(
      resolveRememberedProject({
        remembered: { serverId: "a", projectId: "paseo" },
        projects,
        allServerIds: ["b"],
      }),
    ).toBeNull();
  });
});

describe("rememberedBaseBranchItem", () => {
  it("returns the remembered ref only when the daemon still lists it", () => {
    const details = [{ name: "feat", committerDate: 1, hasLocal: false, hasRemote: true }];
    expect(
      rememberedBaseBranchItem({
        remembered: { refName: "refs/remotes/origin/feat" },
        branchDetails: details,
      }),
    ).toMatchObject({ kind: "branch", refName: "refs/remotes/origin/feat" });
    expect(
      rememberedBaseBranchItem({
        remembered: { refName: "refs/remotes/origin/gone" },
        branchDetails: details,
      }),
    ).toBeNull();
  });
});

describe("rememberNewWorkspaceSelection", () => {
  const paseo = toRememberedProject(project("paseo"), "a");

  it("stores the project and its base branch", () => {
    const next = rememberNewWorkspaceSelection({
      preferences: { isolation: "worktree", baseBranchByProject: { "a:other": { refName: "x" } } },
      project: paseo,
      baseItem: branch("refs/heads/dev"),
    });
    expect(next).toEqual({
      isolation: "worktree",
      lastWorkspaceProject: { serverId: "a", projectId: "paseo" },
      baseBranchByProject: {
        "a:other": { refName: "x" },
        "a:paseo": { refName: "refs/heads/dev" },
      },
    });
  });

  it("keeps the previous base branch when the workspace was not branched off a branch", () => {
    const next = rememberNewWorkspaceSelection({
      preferences: { baseBranchByProject: { "a:paseo": { refName: "refs/heads/dev" } } },
      project: paseo,
      baseItem: null,
    });
    expect(next.baseBranchByProject).toEqual({ "a:paseo": { refName: "refs/heads/dev" } });
    expect(next.lastWorkspaceProject).toEqual({ serverId: "a", projectId: "paseo" });
  });
});
