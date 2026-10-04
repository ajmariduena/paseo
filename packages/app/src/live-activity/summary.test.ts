import { describe, expect, it } from "vitest";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { summarizeAgents, type LiveActivityLabels } from "./summary";

const labels: LiveActivityLabels = {
  headline: ({ working, waiting, finished }) => `${working}w ${waiting}p ${finished}f`,
  working: (count) => `working ${count}`,
  waiting: (count) => `waiting ${count}`,
  permission: "permission",
  finished: "finished",
  failed: "failed",
  untitled: "New session",
};

function agent(overrides: Partial<AgentDirectoryEntry> & { id: string }): AgentDirectoryEntry {
  return {
    serverId: "s1",
    title: overrides.id,
    status: "idle",
    turn: undefined,
    lastActivityAt: new Date(1_000),
    cwd: "/work",
    provider: "claude",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    createdAt: new Date(0),
    labels: {},
    ...overrides,
  } as AgentDirectoryEntry;
}

describe("summarizeAgents", () => {
  it("lists permission requests first, then working agents, then fresh results", () => {
    const content = summarizeAgents({
      agents: [
        agent({
          id: "done",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date(6_000),
        }),
        agent({ id: "busy", status: "running", lastActivityAt: new Date(5_000) }),
        agent({ id: "ask", status: "running", pendingPermissionCount: 1 }),
      ],
      since: 2_000,
      runningSince: new Map([["s1:busy", 4_500]]),
      labels,
    });

    expect(content).toEqual({
      headline: "1w 1p 1f",
      working: 1,
      waiting: 1,
      workingLabel: "working 1",
      waitingLabel: "waiting 1",
      lines: [
        { id: "s1:ask", title: "ask", state: "permission", label: "permission", since: 0 },
        { id: "s1:busy", title: "busy", state: "working", label: "", since: 4 },
        { id: "s1:done", title: "done", state: "finished", label: "finished", since: 0 },
      ],
    });
  });

  it("ignores results from before the activity started and archived agents", () => {
    const content = summarizeAgents({
      agents: [
        agent({
          id: "old",
          requiresAttention: true,
          attentionReason: "error",
          attentionTimestamp: new Date(1_000),
        }),
        agent({ id: "gone", status: "running", archivedAt: new Date(3_000) }),
      ],
      since: 2_000,
      runningSince: new Map(),
      labels,
    });

    expect(content).toBeNull();
  });

  it("shows at most three lines and names untitled agents", () => {
    const content = summarizeAgents({
      agents: ["a", "b", "c", "d"].map((id) => agent({ id, title: null, status: "running" })),
      since: 0,
      runningSince: new Map(),
      labels,
    });

    expect(content?.working).toBe(4);
    expect(content?.lines).toHaveLength(3);
    expect(content?.lines[0]?.title).toBe("New session");
  });
});
