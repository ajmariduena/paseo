import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import { buildWorkspaceAgentActivityIndex } from "@/utils/workspace-agent-activity";
import {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarWorkspaceEntries,
  buildSidebarWorkspacePlacementModel,
  buildSidebarProjectsFromStructure,
  computeSidebarOrderUpdates,
  createSidebarWorkspaceEntry,
  createPendingSidebarWorkspaceEntry,
  deriveProjectStatusBucket,
  deriveSidebarToggleAttentionBucket,
  deriveSidebarLoadingState,
  omitSidebarWorkspaces,
  overlayPendingWorkspaceCreationStatus,
  selectDelegatedSidebarWorkspaceKeys,
  shouldShowSidebarHostLabels,
  type ProjectStatusSession,
  type SidebarProjectEntry,
  type SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";

it("projects a creation without a workspace descriptor into running and failed status", () => {
  const creation = {
    serverId: "host",
    workspaceId: "wks_0123456789abcdef",
    agentId: "00000000-0000-4000-8000-000000000001",
    draftId: "draft-1",
    clientMessageId: "message-1",
    projectViewKey: "project",
    projectId: "project-id",
    projectName: "Project",
    projectKind: "git" as const,
    sourceDirectory: "/repo",
    prompt: "Start here",
    createdAt: 100,
    phase: "preparing" as const,
    revision: 0,
    error: null,
    outcomeUnknown: false,
  };
  const entry = createPendingSidebarWorkspaceEntry(creation);
  expect(entry).toMatchObject({
    workspaceKey: "host:wks_0123456789abcdef",
    name: "Start here",
    statusBucket: "running",
    pendingCreation: "creating",
  });
  expect(
    deriveProjectStatusBucket({
      workspaces: [entry],
      sessions: {},
      pendingWorkspaceCreations: { [entry.workspaceKey]: creation },
    }),
  ).toBe("running");
  const failed = { ...creation, phase: "failed" as const, outcomeUnknown: true };
  expect(createPendingSidebarWorkspaceEntry(failed)).toMatchObject({
    statusBucket: "failed",
    pendingCreation: "failed",
    pendingOutcomeUnknown: true,
  });
});

it("keeps a published workspace running while its pending creation is live", () => {
  const creation = {
    serverId: "host",
    workspaceId: "wks_0123456789abcdef",
    agentId: "00000000-0000-4000-8000-000000000001",
    draftId: "draft-1",
    clientMessageId: "message-1",
    projectViewKey: "project",
    projectId: "project-id",
    projectName: "Project",
    projectKind: "git" as const,
    sourceDirectory: "/repo",
    prompt: "Start here",
    createdAt: 100,
    phase: "accepted" as const,
    revision: 1,
    error: null,
    outcomeUnknown: false,
  };
  const published = {
    ...createSidebarWorkspaceEntry({
      serverId: "host",
      workspace: {
        ...workspaceWithForge(undefined, "https://example.com/pr/1"),
        id: creation.workspaceId,
      },
    }),
  };
  expect(published.statusBucket).toBe("done");
  const entries = new Map([[published.workspaceKey, published]]);

  expect(
    overlayPendingWorkspaceCreationStatus(entries, { [published.workspaceKey]: creation }).get(
      published.workspaceKey,
    ),
  ).toMatchObject({ statusBucket: "running", statusEnteredAt: new Date(100) });
  expect(
    overlayPendingWorkspaceCreationStatus(entries, {
      [published.workspaceKey]: { ...creation, phase: "failed" },
    }),
  ).toBe(entries);
  expect(overlayPendingWorkspaceCreationStatus(entries, {})).toBe(entries);
});

function workspaceWithForge(forge: string | undefined, prUrl: string): WorkspaceDescriptor {
  return {
    id: "ws-1",
    projectId: "proj",
    projectDisplayName: "repo",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "feature",
    title: null,
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    forge,
    githubRuntime: {
      featuresEnabled: true,
      pullRequest: {
        url: prUrl,
        title: "Change",
        state: "open",
        baseRefName: "main",
        headRefName: "feature",
        isMerged: false,
      },
      error: null,
    },
  };
}

describe("createSidebarWorkspaceEntry forge threading", () => {
  it("threads a gitlab summary forge onto the prHint", () => {
    const entry = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: workspaceWithForge("gitlab", "https://gitlab.com/group/proj/-/merge_requests/7"),
    });
    expect(entry.prHint).toMatchObject({ number: 7, forge: "gitlab" });
  });

  it("falls back to github when the summary omits forge (old daemon)", () => {
    const entry = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: workspaceWithForge(undefined, "https://github.com/acme/repo/pull/42"),
    });
    expect(entry.prHint).toMatchObject({ number: 42, forge: "github" });
  });
});

describe("createSidebarWorkspaceEntry workspace directory label", () => {
  it("uses the daemon-provided slug for a Paseo-owned worktree", () => {
    const descriptor = workspaceWithForge(undefined, "https://github.com/acme/repo/pull/42");
    descriptor.workspaceDirectory = "/worktrees/feature/packages/app";
    descriptor.worktreeSlug = "feature";

    const entry = createSidebarWorkspaceEntry({ serverId: "srv", workspace: descriptor });

    expect(entry.workspaceDirectoryLabel).toBe("feature");
  });

  it("shortens the workspace path when the daemon omits a worktree slug", () => {
    const descriptor = workspaceWithForge(undefined, "https://github.com/acme/repo/pull/42");
    descriptor.workspaceDirectory = "/home/alice/external/feature";

    const entry = createSidebarWorkspaceEntry({ serverId: "srv", workspace: descriptor });

    expect(entry.workspaceDirectoryLabel).toBe("~/external/feature");
  });
});

describe("waiting workspace projection", () => {
  it("uses the optional child count to display waiting while preserving the wire running status", () => {
    const descriptor = workspaceWithForge(undefined, "https://github.com/acme/repo/pull/42");
    descriptor.status = "running";
    descriptor.waitingOnSubagents = { count: 2 };
    const entry = createSidebarWorkspaceEntry({ serverId: "srv", workspace: descriptor });
    expect(entry.statusBucket).toBe("waiting");
    expect(entry.waitingOnSubagentsCount).toBe(2);
    expect(descriptor.status).toBe("running");
  });
});

interface OrderedItem {
  key: string;
}

function item(key: string): OrderedItem {
  return { key };
}

function project(input: {
  projectKey: string;
  projectName?: string;
  projectKind?: WorkspaceStructureProject["projectKind"];
  iconWorkingDir?: string;
  workspaceKeys: string[];
  hosts?: Array<
    Omit<WorkspaceStructureProject["hosts"][number], "projectId"> & { projectId?: string }
  >;
}): WorkspaceStructureProject {
  return {
    viewKey: input.projectKey,
    projectKey: input.projectKey,
    projectName: input.projectName ?? input.projectKey,
    projectKind: input.projectKind ?? "git",
    iconWorkingDir: input.iconWorkingDir ?? input.projectKey,
    hosts: Array.from(
      input.hosts ?? [
        {
          serverId: "srv",
          iconWorkingDir: input.iconWorkingDir ?? input.projectKey,
          worktreeSupport: "supported" as const,
        },
      ],
      (host) => Object.assign({}, host, { projectId: host.projectId ?? input.projectKey }),
    ),
    workspaceKeys: input.workspaceKeys,
  };
}

function sidebarProject(input: {
  projectKey: string;
  workspaceKeys: string[];
}): SidebarProjectEntry {
  const projects = buildSidebarProjectsFromStructure({
    projects: [project({ projectKey: input.projectKey, workspaceKeys: input.workspaceKeys })],
  });
  const result = projects[0];
  if (!result) {
    throw new Error("expected a project entry");
  }
  return result;
}

function workspace(input: {
  id: string;
  name: string;
  projectId: string;
  projectDisplayName: string;
  status?: WorkspaceDescriptor["status"];
  statusEnteredAt?: Date | null;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: input.projectDisplayName,
    projectRootPath: `/repo/${input.projectId}`,
    workspaceDirectory: `/repo/${input.projectId}/${input.id}`,
    projectKind: "git",
    workspaceKind: input.name === "main" ? "local_checkout" : "worktree",
    name: input.name,
    status: input.status ?? "done",
    statusEnteredAt: input.statusEnteredAt ?? null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("applyStoredOrdering", () => {
  it("keeps unknown items on the baseline while applying stored order", () => {
    const result = applyStoredOrdering({
      items: [item("new"), item("a"), item("b")],
      storedOrder: ["b", "a"],
      getKey: (entry) => entry.key,
    });

    expect(result.map((entry) => entry.key)).toEqual(["new", "b", "a"]);
  });

  it("ignores stale and duplicate stored keys", () => {
    const result = applyStoredOrdering({
      items: [item("x"), item("y")],
      storedOrder: ["missing", "y", "y", "x"],
      getKey: (entry) => entry.key,
    });

    expect(result.map((entry) => entry.key)).toEqual(["y", "x"]);
  });

  it("returns baseline when there is no persisted order", () => {
    const baseline = [item("first"), item("second")];
    const result = applyStoredOrdering({
      items: baseline,
      storedOrder: [],
      getKey: (entry) => entry.key,
    });

    expect(result).toBe(baseline);
  });
});

describe("appendMissingOrderKeys", () => {
  it("appends unseen keys while preserving existing order", () => {
    const result = appendMissingOrderKeys({
      currentOrder: ["project-b", "project-a"],
      visibleKeys: ["project-a", "project-b", "project-c"],
    });

    expect(result).toEqual(["project-b", "project-a", "project-c"]);
  });

  it("returns the same array when there are no unseen keys", () => {
    const currentOrder = ["project-a", "project-b"];

    const result = appendMissingOrderKeys({
      currentOrder,
      visibleKeys: ["project-b", "project-a"],
    });

    expect(result).toBe(currentOrder);
  });
});

describe("delegated subagent workspaces", () => {
  it("hides workspaces an active parent's subagents own, unless pinned", () => {
    const delegated = { ...workspaceWithForge(undefined, ""), id: "ws-child" };
    const pinned = {
      ...workspaceWithForge(undefined, ""),
      id: "ws-pinned",
      pinnedAt: "2026-10-05T00:00:00.000Z",
      delegatedByAgentId: "parent",
    };
    const keys = selectDelegatedSidebarWorkspaceKeys(
      {
        srv: {
          workspaces: new Map([
            ["ws-main", workspaceWithForge(undefined, "")],
            ["ws-child", { ...delegated, delegatedByAgentId: "parent" }],
            ["ws-pinned", pinned],
          ]),
        },
      },
      ["srv"],
    );
    expect(keys).toEqual(["srv:ws-child"]);

    const projects = omitSidebarWorkspaces(
      [project({ projectKey: "p", workspaceKeys: ["srv:ws-1", "srv:ws-child", "srv:ws-pinned"] })],
      keys,
    );
    expect(projects[0]?.workspaceKeys).toEqual(["srv:ws-1", "srv:ws-pinned"]);
  });
});

describe("buildSidebarProjectsFromStructure", () => {
  it("creates structural workspace rows from ordered workspace keys", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-1",
          projectName: "Project 1",
          iconWorkingDir: "/repo/main",
          workspaceKeys: ["ws-main"],
        }),
      ],
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectName).toBe("Project 1");
    expect(projects[0]?.workspaces[0]).toMatchObject({
      workspaceKey: "srv:ws-main",
      serverId: "srv",
      workspaceId: "ws-main",
      projectRootPath: "/repo/main",
      projectKind: "git",
    });
  });

  it("preserves the structure hook project order", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({ projectKey: "project-b", workspaceKeys: ["ws-b"] }),
        project({ projectKey: "project-a", workspaceKeys: ["ws-a"] }),
      ],
    });

    expect(projects.map((entry) => entry.viewKey)).toEqual(["project-b", "project-a"]);
  });

  it("preserves the structure hook workspace order", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [project({ projectKey: "project-1", workspaceKeys: ["feature", "main"] })],
    });

    expect(projects[0]?.workspaces.map((placement) => placement.workspaceId)).toEqual([
      "feature",
      "main",
    ]);
  });

  it("resolves workspace keys by known host prefix when server ids contain colons", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-1",
          hosts: [
            {
              serverId: "relay:paseo-host",
              iconWorkingDir: "/repo/project-1",
              worktreeSupport: "supported" as const,
            },
          ],
          workspaceKeys: ["relay:paseo-host:ws-main"],
        }),
      ],
    });

    expect(projects[0]?.workspaces[0]).toMatchObject({
      workspaceKey: "relay:paseo-host:ws-main",
      serverId: "relay:paseo-host",
      workspaceId: "ws-main",
    });
  });
});

describe("shared sidebar workspace model", () => {
  it("feeds project placement and status grouping from the same cross-host workspace identities", () => {
    const model = buildSidebarWorkspacePlacementModel({
      projects: [
        project({
          projectKey: "getpaseo/paseo",
          projectName: "getpaseo/paseo",
          iconWorkingDir: "/repo/getpaseo/paseo",
          hosts: [
            {
              serverId: "host-a",
              iconWorkingDir: "/repo/getpaseo/paseo",
              worktreeSupport: "supported" as const,
            },
            {
              serverId: "host-b",
              iconWorkingDir: "/repo/getpaseo/paseo",
              worktreeSupport: "supported" as const,
            },
          ],
          workspaceKeys: ["host-a:main", "host-b:feature"],
        }),
      ],
    });
    const workspaceEntries = buildSidebarWorkspaceEntries({
      placements: model.workspaces,
      sessions: [
        {
          serverId: "host-a",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            [
              "main",
              workspace({
                id: "main",
                name: "main",
                projectId: "getpaseo/paseo",
                projectDisplayName: "getpaseo/paseo",
                status: "done",
              }),
            ],
          ]),
        },
        {
          serverId: "host-b",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            [
              "feature",
              workspace({
                id: "feature",
                name: "feature/status-flow",
                projectId: "getpaseo/paseo",
                projectDisplayName: "getpaseo/paseo",
                status: "running",
                statusEnteredAt: new Date("2026-06-10T00:00:00.000Z"),
              }),
            ],
          ]),
        },
      ],
    });

    expect(model.workspaces.map((entry) => entry.workspaceKey)).toEqual([
      "host-a:main",
      "host-b:feature",
    ]);
    expect(model.projects).toEqual([
      expect.objectContaining({
        viewKey: "getpaseo/paseo",
        hosts: [
          {
            serverId: "host-a",
            projectId: "getpaseo/paseo",
            iconWorkingDir: "/repo/getpaseo/paseo",
            worktreeSupport: "supported" as const,
          },
          {
            serverId: "host-b",
            projectId: "getpaseo/paseo",
            iconWorkingDir: "/repo/getpaseo/paseo",
            worktreeSupport: "supported" as const,
          },
        ],
        workspaces: [
          expect.objectContaining({
            workspaceKey: "host-a:main",
            serverId: "host-a",
            name: "main",
          }),
          expect.objectContaining({
            workspaceKey: "host-b:feature",
            serverId: "host-b",
            name: "feature",
          }),
        ],
      }),
    ]);
    expect(
      Array.from(workspaceEntries.values()).map((entry) => [
        entry.workspaceKey,
        entry.statusBucket,
        entry.name,
      ]),
    ).toEqual([
      ["host-a:main", "done", "main"],
      ["host-b:feature", "running", "feature/status-flow"],
    ]);
    expect(model.projectNamesByViewKey).toEqual(new Map([["getpaseo/paseo", "getpaseo/paseo"]]));
  });

  it("preserves unchanged row identities when another workspace updates", () => {
    const model = buildSidebarWorkspacePlacementModel({
      projects: [project({ projectKey: "project", workspaceKeys: ["srv:one", "srv:two"] })],
    });
    const one = workspace({
      id: "one",
      name: "one",
      projectId: "project",
      projectDisplayName: "project",
    });
    const two = workspace({
      id: "two",
      name: "two",
      projectId: "project",
      projectDisplayName: "project",
    });
    const previousEntries = buildSidebarWorkspaceEntries({
      placements: model.workspaces,
      sessions: [
        {
          serverId: "srv",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            ["one", one],
            ["two", two],
          ]),
        },
      ],
    });
    const nextEntries = buildSidebarWorkspaceEntries({
      placements: model.workspaces,
      sessions: [
        {
          serverId: "srv",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            ["one", one],
            ["two", { ...two, status: "running" }],
          ]),
        },
      ],
      previousEntries,
    });

    expect(nextEntries.get("srv:one")).toBe(previousEntries.get("srv:one"));
    expect(nextEntries.get("srv:two")).not.toBe(previousEntries.get("srv:two"));
  });

  it("keeps a structurally disambiguated project key in status entries", () => {
    const projectKey = "host:srv:project:prj_a";
    const model = buildSidebarWorkspacePlacementModel({
      projects: [project({ projectKey, projectName: "Clone A", workspaceKeys: ["srv:clone-a"] })],
    });
    const entries = buildSidebarWorkspaceEntries({
      placements: model.workspaces,
      sessions: [
        {
          serverId: "srv",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            [
              "clone-a",
              workspace({
                id: "clone-a",
                name: "main",
                projectId: "prj_a",
                projectDisplayName: "acme/app",
              }),
            ],
          ]),
        },
      ],
    });

    expect(entries.get("srv:clone-a")?.projectViewKey).toBe(projectKey);
  });
});

describe("shouldShowSidebarHostLabels", () => {
  it("is false with no visible projects", () => {
    expect(shouldShowSidebarHostLabels([])).toBe(false);
  });

  it("is false when every project lives on a single host", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({ projectKey: "project-a", workspaceKeys: ["ws-1"] }),
        project({ projectKey: "project-b", workspaceKeys: ["ws-2"] }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(false);
  });

  it("is true when projects span separate hosts", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-a",
          hosts: [
            {
              serverId: "host-a",
              iconWorkingDir: "/repo/project-a",
              worktreeSupport: "supported" as const,
            },
          ],
          workspaceKeys: ["host-a:ws-1"],
        }),
        project({
          projectKey: "project-b",
          hosts: [
            {
              serverId: "host-b",
              iconWorkingDir: "/repo/project-b",
              worktreeSupport: "supported" as const,
            },
          ],
          workspaceKeys: ["host-b:ws-2"],
        }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(true);
  });

  it("is true for a single project shared across hosts", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "getpaseo/paseo",
          hosts: [
            {
              serverId: "host-a",
              iconWorkingDir: "/repo/paseo",
              worktreeSupport: "supported" as const,
            },
            {
              serverId: "host-b",
              iconWorkingDir: "/repo/paseo",
              worktreeSupport: "supported" as const,
            },
          ],
          workspaceKeys: ["host-a:main", "host-b:feature"],
        }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(true);
  });
});

describe("computeSidebarOrderUpdates", () => {
  it("returns no updates when there are no visible projects", () => {
    const updates = computeSidebarOrderUpdates({
      projects: [],
      persistedProjectOrder: ["stale-project"],
      getWorkspaceOrder: () => [],
    });

    expect(updates).toEqual({ projectOrder: null, workspaceOrders: [] });
  });

  it("appends unseen projects while putting unseen workspaces before the saved order", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-1", "ws-2"] }),
      sidebarProject({ projectKey: "project-b", workspaceKeys: ["ws-3"] }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-a"],
      getWorkspaceOrder: (projectKey) => (projectKey === "project-a" ? ["srv:ws-1"] : []),
    });

    expect(updates.projectOrder).toEqual(["project-a", "project-b"]);
    expect(updates.workspaceOrders).toEqual([
      { projectViewKey: "project-a", order: ["srv:ws-2", "srv:ws-1"] },
      { projectViewKey: "project-b", order: ["srv:ws-3"] },
    ]);
  });

  it("preserves the saved workspace order behind multiple newly discovered workspaces", () => {
    const projects = [
      sidebarProject({
        projectKey: "project-a",
        workspaceKeys: ["newest", "newer", "old-a", "old-b"],
      }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-a"],
      getWorkspaceOrder: () => ["srv:old-b", "srv:old-a"],
    });

    expect(updates.workspaceOrders).toEqual([
      {
        projectViewKey: "project-a",
        order: ["srv:newest", "srv:newer", "srv:old-b", "srv:old-a"],
      },
    ]);
  });

  it("returns no project-order update when persisted order already covers visible keys", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-1"] }),
      sidebarProject({ projectKey: "project-b", workspaceKeys: ["ws-2"] }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-b", "project-a"],
      getWorkspaceOrder: (projectKey) => (projectKey === "project-a" ? ["srv:ws-1"] : ["srv:ws-2"]),
    });

    expect(updates.projectOrder).toBeNull();
    expect(updates.workspaceOrders).toEqual([]);
  });
});

describe("deriveSidebarLoadingState", () => {
  it("reports initial-load while active and unhydrated with no projects", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: false,
      }),
    ).toEqual({ isLoading: true, isInitialLoad: true, isRevalidating: false });
  });

  it("stays loading but not initial once projects are visible", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: true,
      }),
    ).toEqual({ isLoading: true, isInitialLoad: false, isRevalidating: false });
  });

  it("clears loading once workspaces have hydrated", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: ["srv"],
        hasProjects: true,
      }),
    ).toEqual({ isLoading: false, isInitialLoad: false, isRevalidating: false });
  });

  it("short-circuits to idle when inactive", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: false,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: false,
      }),
    ).toEqual({ isLoading: false, isInitialLoad: false, isRevalidating: false });
  });
});

function workspacePlacement(input: {
  serverId?: string;
  workspaceId: string;
  projectViewKey?: string;
}): SidebarWorkspacePlacement {
  const serverId = input.serverId ?? "srv";
  const projectViewKey = input.projectViewKey ?? "project-a";
  return {
    workspaceKey: `${serverId}:${input.workspaceId}`,
    serverId,
    workspaceId: input.workspaceId,
    projectViewKey,
    projectName: projectViewKey,
    projectKind: "git",
    workspaceKind: "worktree",
    name: input.workspaceId,
  };
}

function agent(input: {
  id: string;
  workspaceId: string;
  status: Agent["status"];
  updatedAt?: Date;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
}): Agent {
  return {
    serverId: "srv",
    id: input.id,
    provider: "claude" as Agent["provider"],
    status: input.status,
    turn:
      input.status === "running"
        ? { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null }
        : { phase: "idle", cancellationRequestId: null },
    createdAt: new Date(0),
    updatedAt: input.updatedAt ?? new Date(1_000),
    lastUserMessageAt: null,
    lastActivityAt: new Date(1_000),
    capabilities: {} as Agent["capabilities"],
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    model: null,
    parentAgentId: input.parentAgentId ?? null,
    archivedAt: input.archivedAt ?? null,
    labels: {},
  };
}

function sessionWith(input: {
  workspaces: WorkspaceDescriptor[];
  agents?: Agent[];
}): ProjectStatusSession {
  return {
    workspaces: new Map(input.workspaces.map((entry) => [entry.id, entry])),
    workspaceAgentActivity: buildWorkspaceAgentActivityIndex(
      new Map((input.agents ?? []).map((entry) => [entry.id, entry])),
    ),
  };
}

function projectWorkspace(id: string, status: WorkspaceDescriptor["status"]): WorkspaceDescriptor {
  return workspace({
    id,
    name: id,
    projectId: "project-a",
    projectDisplayName: "project-a",
    status,
  });
}

describe("deriveProjectStatusBucket", () => {
  it("is done when the project has no workspaces", () => {
    expect(deriveProjectStatusBucket({ workspaces: [], sessions: {} })).toBe("done");
  });

  it("is done when every workspace is done", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [
          workspacePlacement({ workspaceId: "ws-1" }),
          workspacePlacement({ workspaceId: "ws-2" }),
        ],
        sessions: {
          srv: sessionWith({
            workspaces: [projectWorkspace("ws-1", "done"), projectWorkspace("ws-2", "done")],
          }),
        },
      }),
    ).toBe("done");
  });

  it("surfaces the most urgent workspace status in the project", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [
          workspacePlacement({ workspaceId: "ws-1" }),
          workspacePlacement({ workspaceId: "ws-2" }),
          workspacePlacement({ workspaceId: "ws-3" }),
        ],
        sessions: {
          srv: sessionWith({
            workspaces: [
              projectWorkspace("ws-1", "done"),
              projectWorkspace("ws-2", "running"),
              projectWorkspace("ws-3", "needs_input"),
            ],
          }),
        },
      }),
    ).toBe("needs_input");
  });

  it("keeps a working project on running when a finished workspace also awaits review", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [
          workspacePlacement({ workspaceId: "ws-1" }),
          workspacePlacement({ workspaceId: "ws-2" }),
        ],
        sessions: {
          srv: sessionWith({
            workspaces: [
              projectWorkspace("ws-1", "running"),
              projectWorkspace("ws-2", "attention"),
            ],
          }),
        },
      }),
    ).toBe("running");
  });

  it("surfaces needs_input over a concurrently running workspace", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [
          workspacePlacement({ workspaceId: "ws-1" }),
          workspacePlacement({ workspaceId: "ws-2" }),
        ],
        sessions: {
          srv: sessionWith({
            workspaces: [
              projectWorkspace("ws-1", "needs_input"),
              projectWorkspace("ws-2", "running"),
            ],
          }),
        },
      }),
    ).toBe("needs_input");
  });

  it("surfaces failed over a concurrently running workspace", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [
          workspacePlacement({ workspaceId: "ws-1" }),
          workspacePlacement({ workspaceId: "ws-2" }),
        ],
        sessions: {
          srv: sessionWith({
            workspaces: [projectWorkspace("ws-1", "failed"), projectWorkspace("ws-2", "running")],
          }),
        },
      }),
    ).toBe("failed");
  });

  it("keeps a project on attention when only one workspace awaits review", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [
          workspacePlacement({ workspaceId: "ws-1" }),
          workspacePlacement({ workspaceId: "ws-2" }),
        ],
        sessions: {
          srv: sessionWith({
            workspaces: [projectWorkspace("ws-1", "attention"), projectWorkspace("ws-2", "done")],
          }),
        },
      }),
    ).toBe("attention");
  });

  it("aggregates across the hosts a project spans", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [
          workspacePlacement({ serverId: "srv", workspaceId: "ws-1" }),
          workspacePlacement({ serverId: "other", workspaceId: "ws-9" }),
        ],
        sessions: {
          srv: sessionWith({ workspaces: [projectWorkspace("ws-1", "done")] }),
          other: sessionWith({ workspaces: [projectWorkspace("ws-9", "running")] }),
        },
      }),
    ).toBe("running");
  });

  it("skips workspaces whose session has not hydrated yet", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [
          workspacePlacement({ workspaceId: "ws-1" }),
          workspacePlacement({ serverId: "offline", workspaceId: "ws-2" }),
        ],
        sessions: {
          srv: sessionWith({ workspaces: [projectWorkspace("ws-1", "running")] }),
        },
      }),
    ).toBe("running");
  });

  it("lifts a done workspace when one of its root agents is still working", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [workspacePlacement({ workspaceId: "ws-1" })],
        sessions: {
          srv: sessionWith({
            workspaces: [projectWorkspace("ws-1", "done")],
            agents: [agent({ id: "a1", workspaceId: "ws-1", status: "running" })],
          }),
        },
      }),
    ).toBe("running");
  });

  it("ignores archived agents and subagents", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [workspacePlacement({ workspaceId: "ws-1" })],
        sessions: {
          srv: sessionWith({
            workspaces: [projectWorkspace("ws-1", "done")],
            agents: [
              agent({
                id: "archived",
                workspaceId: "ws-1",
                status: "running",
                archivedAt: new Date(2_000),
              }),
              agent({
                id: "subagent",
                workspaceId: "ws-1",
                status: "running",
                parentAgentId: "a1",
              }),
            ],
          }),
        },
      }),
    ).toBe("done");
  });

  it("ignores agents belonging to workspaces outside the project", () => {
    expect(
      deriveProjectStatusBucket({
        workspaces: [workspacePlacement({ workspaceId: "ws-1" })],
        sessions: {
          srv: sessionWith({
            workspaces: [projectWorkspace("ws-1", "done"), projectWorkspace("ws-other", "done")],
            agents: [agent({ id: "a1", workspaceId: "ws-other", status: "running" })],
          }),
        },
      }),
    ).toBe("done");
  });
});

describe("deriveSidebarToggleAttentionBucket", () => {
  const active = { serverId: "srv", workspaceId: "ws-active" };

  it("is null when no other workspace needs you", () => {
    expect(
      deriveSidebarToggleAttentionBucket({
        sessions: {
          srv: sessionWith({
            workspaces: [
              projectWorkspace("ws-active", "done"),
              projectWorkspace("ws-1", "running"),
              projectWorkspace("ws-2", "attention"),
            ],
          }),
        },
        activeWorkspace: active,
        isSidebarOpen: false,
      }),
    ).toBeNull();
  });

  it("surfaces another workspace waiting on input", () => {
    expect(
      deriveSidebarToggleAttentionBucket({
        sessions: {
          srv: sessionWith({
            workspaces: [
              projectWorkspace("ws-active", "done"),
              projectWorkspace("ws-1", "needs_input"),
            ],
          }),
        },
        activeWorkspace: active,
        isSidebarOpen: false,
      }),
    ).toBe("needs_input");
  });

  it("surfaces another failed workspace", () => {
    expect(
      deriveSidebarToggleAttentionBucket({
        sessions: {
          srv: sessionWith({
            workspaces: [projectWorkspace("ws-active", "done"), projectWorkspace("ws-1", "failed")],
          }),
        },
        activeWorkspace: active,
        isSidebarOpen: false,
      }),
    ).toBe("failed");
  });

  it("ranks needs_input over failed", () => {
    expect(
      deriveSidebarToggleAttentionBucket({
        sessions: {
          srv: sessionWith({
            workspaces: [
              projectWorkspace("ws-1", "failed"),
              projectWorkspace("ws-2", "needs_input"),
            ],
          }),
        },
        activeWorkspace: active,
        isSidebarOpen: false,
      }),
    ).toBe("needs_input");
  });

  it("excludes the active workspace", () => {
    expect(
      deriveSidebarToggleAttentionBucket({
        sessions: {
          srv: sessionWith({
            workspaces: [
              projectWorkspace("ws-active", "needs_input"),
              projectWorkspace("ws-1", "done"),
            ],
          }),
        },
        activeWorkspace: active,
        isSidebarOpen: false,
      }),
    ).toBeNull();
  });

  it("only excludes the active workspace on its own host", () => {
    expect(
      deriveSidebarToggleAttentionBucket({
        sessions: {
          srv: sessionWith({ workspaces: [projectWorkspace("ws-active", "done")] }),
          other: sessionWith({ workspaces: [projectWorkspace("ws-active", "failed")] }),
        },
        activeWorkspace: active,
        isSidebarOpen: false,
      }),
    ).toBe("failed");
  });

  it("counts every workspace when none is active", () => {
    expect(
      deriveSidebarToggleAttentionBucket({
        sessions: {
          srv: sessionWith({ workspaces: [projectWorkspace("ws-active", "needs_input")] }),
        },
        activeWorkspace: null,
        isSidebarOpen: false,
      }),
    ).toBe("needs_input");
  });

  it("is hidden while the sidebar is open", () => {
    expect(
      deriveSidebarToggleAttentionBucket({
        sessions: {
          srv: sessionWith({ workspaces: [projectWorkspace("ws-1", "needs_input")] }),
        },
        activeWorkspace: active,
        isSidebarOpen: true,
      }),
    ).toBeNull();
  });
});
