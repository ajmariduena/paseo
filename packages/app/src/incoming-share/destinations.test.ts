import { describe, expect, it } from "vitest";
import { buildShareAgentOptions, buildShareWorkspaceOptions } from "./destinations";

interface WorkspaceFixture {
  id: string;
  name: string;
  title?: string;
  currentBranch: string | null;
  archivingAt?: string;
}

function workspace(id: string, overrides: Partial<WorkspaceFixture> = {}): WorkspaceFixture {
  return { id, name: id, currentBranch: null, ...overrides };
}

function project(input: { serverId: string; projectName: string; workspaces: WorkspaceFixture[] }) {
  return {
    hosts: [
      {
        serverId: input.serverId,
        projectName: input.projectName,
        projectCustomName: null,
        workspaces: input.workspaces,
      },
    ],
  };
}

interface AgentFixture {
  id: string;
  serverId: string;
  workspaceId?: string;
  title: string | null;
  lastActivityAt: Date;
  archivedAt?: Date | null;
}

function agent(id: string, overrides: Partial<AgentFixture> = {}): AgentFixture {
  return {
    id,
    serverId: "host-a",
    workspaceId: "ws-1",
    title: id,
    lastActivityAt: new Date(0),
    archivedAt: null,
    ...overrides,
  };
}

describe("buildShareWorkspaceOptions", () => {
  const projects = [
    project({
      serverId: "host-a",
      projectName: "paseo",
      workspaces: [
        workspace("ws-2", { name: "beta", currentBranch: "feat/beta" }),
        workspace("ws-1", { name: "alpha", title: "Alpha work" }),
        workspace("ws-3", { name: "gone", archivingAt: "2026-10-01T00:00:00Z" }),
      ],
    }),
    project({ serverId: "host-b", projectName: "other", workspaces: [workspace("ws-9")] }),
  ];

  it("lists the host's live workspaces by title", () => {
    const options = buildShareWorkspaceOptions({
      projects,
      serverId: "host-a",
      query: "",
      lastWorkspaceId: null,
    });
    expect(options).toEqual([
      { workspaceId: "ws-1", title: "Alpha work", subtitle: "paseo" },
      { workspaceId: "ws-2", title: "beta", subtitle: "paseo · feat/beta" },
    ]);
  });

  it("leads with the last workspace", () => {
    const options = buildShareWorkspaceOptions({
      projects,
      serverId: "host-a",
      query: "",
      lastWorkspaceId: "ws-2",
    });
    expect(options.map((option) => option.workspaceId)).toEqual(["ws-2", "ws-1"]);
  });

  it("filters by title, project and branch", () => {
    const search = (query: string) =>
      buildShareWorkspaceOptions({
        projects,
        serverId: "host-a",
        query,
        lastWorkspaceId: null,
      }).map((option) => option.workspaceId);
    expect(search("ALPHA")).toEqual(["ws-1"]);
    expect(search("feat/")).toEqual(["ws-2"]);
    expect(search("nothing")).toEqual([]);
  });
});

describe("buildShareAgentOptions", () => {
  it("lists the workspace's live agents, most recent first", () => {
    const options = buildShareAgentOptions({
      agents: [
        agent("old", { lastActivityAt: new Date(1_000) }),
        agent("new", { lastActivityAt: new Date(2_000), title: null }),
        agent("archived", { archivedAt: new Date(3_000) }),
        agent("elsewhere", { workspaceId: "ws-2" }),
        agent("other-host", { serverId: "host-b" }),
      ],
      serverId: "host-a",
      workspaceId: "ws-1",
    });
    expect(options.map((option) => [option.agentId, option.title])).toEqual([
      ["new", null],
      ["old", "old"],
    ]);
  });
});
