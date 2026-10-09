import { describe, expect, it } from "vitest";
import type { VoiceFleetAgent } from "@getpaseo/protocol/voice-fleet/types";
import { FleetView, type FleetHost } from "./fleet-view.js";

const UPDATED = "2026-10-09T14:00:00.000Z";
const NOW = Date.parse(UPDATED);

function agent(
  id: string,
  title: string,
  overrides: Partial<VoiceFleetAgent> = {},
): VoiceFleetAgent {
  return {
    agentId: id,
    title,
    provider: "codex",
    workspaceId: "workspace-a",
    workspace: "Integración",
    status: "working",
    updatedAt: UPDATED,
    ...overrides,
  };
}

function host(serverId: string | null, label: string, agents: VoiceFleetAgent[] = []): FleetHost {
  return {
    serverId,
    label,
    online: true,
    supportsTools: true,
    lastSeenAt: UPDATED,
    digest: { generatedAt: UPDATED, agents, workspaces: [], projects: [], sessions: [] },
  };
}

describe("FleetView resolution", () => {
  it("resolves a ref, exact id or unique normalized title to the same target", () => {
    const view = new FleetView(
      [host(null, "Portátil", [agent("audio-agent", "Revisión de Audio")])],
      NOW,
    );
    expect(view.resolve(" A1 ")).toMatchObject({
      kind: "agent",
      ref: "a1",
      agent: { agentId: "audio-agent" },
    });
    expect(view.resolve("audio-agent")).toBe(view.resolve("a1"));
    expect(view.resolve("revision de audio")).toBe(view.resolve("a1"));
    expect(view.resolve("audio")).toBe(view.resolve("a1"));
    expect(view.resolve("missing")).toBe(null);
    expect(view.resolve("a")).toBe(null);
  });

  it("requires disambiguation for duplicate names across hosts", () => {
    const view = new FleetView(
      [
        host(null, "Portátil", [agent("agent-laptop", "Upstream")]),
        host("mini", "Mini", [agent("agent-mini", "Upstream")]),
      ],
      NOW,
    );
    expect(view.resolve("Upstream")).toBe(null);
    expect(view.resolve("a1")).toMatchObject({ host: { serverId: null } });
    expect(view.resolve("a2")).toMatchObject({ host: { serverId: "mini" } });
    expect(view.resolve("mini")).toMatchObject({ kind: "host", host: { serverId: "mini" } });
    expect(view.localHost?.label).toBe("Portátil");
  });

  it("resolves projects, workspaces and older sessions without loading an agent", () => {
    const mini = host("mini", "Mini");
    mini.digest = {
      generatedAt: UPDATED,
      agents: [],
      projects: [{ projectId: "project-paseo", name: "Paseo", rootPath: "/work/paseo" }],
      workspaces: [
        {
          workspaceId: "workspace-upgrade",
          title: "Upgrade",
          projectId: "project-paseo",
          cwd: "/work/paseo-upgrade",
          kind: "worktree",
        },
      ],
      sessions: [
        {
          agentId: "session-bt",
          title: "Bluetooth",
          workspace: "Upgrade",
          lastActivityAt: UPDATED,
        },
      ],
    };
    const view = new FleetView([mini], NOW);
    expect(view.resolve("project-paseo")).toMatchObject({ kind: "project", ref: "p1" });
    expect(view.resolve("workspace-upgrade")).toMatchObject({ kind: "workspace", ref: "w1" });
    expect(view.resolve("session-bt")).toMatchObject({ kind: "session", ref: "s1" });
    expect(view.resolve("Paseo")).toBe(view.resolve("p1"));
  });

  it("does not duplicate an already visible agent as an older session on the same host", () => {
    const laptop = host(null, "Portátil", [agent("agent-a", "Upstream")]);
    laptop.digest!.sessions.push({
      agentId: "agent-a",
      title: "Upstream",
      workspace: "Integración",
      lastActivityAt: UPDATED,
    });
    const view = new FleetView([laptop], NOW);
    expect(view.findSessions("Upstream").map((target) => target.kind)).toEqual(["agent"]);
  });

  it("does not resolve a bare resource id shared by two hosts to the first host", () => {
    const view = new FleetView(
      [
        host(null, "Portátil", [agent("copied-id", "Upstream local")]),
        host("mini", "Mini", [agent("copied-id", "Upstream mini")]),
      ],
      NOW,
    );
    expect(view.resolve("copied-id")).toBe(null);
    expect(view.resolve("a2")).toMatchObject({ host: { serverId: "mini" } });
  });

  it("keeps an older session on another host even when its id matches a live agent", () => {
    const mini = host("mini", "Mini");
    mini.digest!.sessions.push({
      agentId: "copied-id",
      title: "Histórico del Mini",
      workspace: "Archivo",
      lastActivityAt: UPDATED,
    });
    const view = new FleetView(
      [host(null, "Portátil", [agent("copied-id", "Actual del portátil")]), mini],
      NOW,
    );
    expect(view.resolve("s1")).toMatchObject({
      kind: "session",
      host: { serverId: "mini" },
      session: { title: "Histórico del Mini" },
    });
  });
});

describe("FleetView search and context", () => {
  it("finds work from the task and workspace even when the title does not match", () => {
    const view = new FleetView(
      [
        host(null, "Portátil", [
          agent("agent-a", "Upstream", {
            task: "Actualizar Paseo y revisar integración",
            workspace: "Audio",
          }),
        ]),
      ],
      NOW,
    );
    expect(view.findSessions("paseo integración").map((target) => target.ref)).toEqual(["a1"]);
    expect(view.findSessions("audio").map((target) => target.ref)).toEqual(["a1"]);
    expect(view.findSessions("el de")).toEqual([]);
    expect(view.findSessions("no-existe")).toEqual([]);
  });

  it("ranks multiple word matches ahead of single matches and bounds the result", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      agent(`agent-${i}`, `Audio ${i}`, {
        task: i === 7 ? "Bluetooth integración" : "Integración",
      }),
    );
    const view = new FleetView([host(null, "Portátil", agents)], NOW);
    const found = view.findSessions("audio bluetooth");
    expect(found).toHaveLength(6);
    expect(found[0]).toMatchObject({ kind: "agent", agent: { agentId: "agent-7" } });
  });

  it("includes the project-workspace-agent relationship and offline freshness", () => {
    const mini = host("mini", "Mini", [agent("agent-a", "Upstream")]);
    mini.online = false;
    mini.lastSeenAt = new Date(NOW - 8 * 60_000).toISOString();
    mini.digest!.projects.push({
      projectId: "project-paseo",
      name: "Paseo",
      rootPath: "/work/paseo",
    });
    mini.digest!.workspaces.push({
      workspaceId: "workspace-a",
      title: "Integración",
      projectId: "project-paseo",
      cwd: "/work/paseo",
      kind: "local",
    });
    const view = new FleetView([host(null, "Portátil"), mini], NOW);
    expect(view.routerContext()).toContain(
      "h2 Mini — offline, last seen 8 min ago; no actions possible",
    );
    expect(view.routerContext()).toContain('w1 "Integración" [Mini] — local, project p1');
    expect(view.routerContext()).toContain("a1 (w1) Mini · Integración");
    expect(view.liveHostNotes()[1]?.line).toBe(
      "Mini is offline since 8 min ago; its agents' state is from then, and actions on it are not possible now.",
    );
  });
});
