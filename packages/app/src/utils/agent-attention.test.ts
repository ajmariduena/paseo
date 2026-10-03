import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  pickAttentionAgent,
  pickNextAttentionAgent,
  shouldClearAgentAttention,
} from "@/utils/agent-attention";

function createAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  const { id, ...rest } = input;
  return {
    serverId: "server-1",
    id,
    provider: "codex",
    status: "idle",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo/worktree",
    model: null,
    parentAgentId: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    ...rest,
    turn: rest.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

describe("shouldClearAgentAttention", () => {
  it("returns true only when the agent is connected and requires attention", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe(true);
  });

  it("returns false when the app is disconnected", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: false,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe(false);
  });

  it("returns false when attention is already clear", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe(false);
  });

  it("returns false for empty agent ids", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe(false);
  });

  it("returns false for permission-shaped attention", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe(false);
  });

  it("returns false for focus entry when clear was deferred while already focused", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
        trigger: "focus-entry",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(false);
  });

  it("returns true for explicit follow-up entrypoints after deferred focus clear", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
        trigger: "input-focus",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(true);

    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
        trigger: "prompt-send",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(true);

    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
        trigger: "agent-blur",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(true);
  });
});

describe("pickAttentionAgent", () => {
  it("returns null for empty input", () => {
    expect(pickAttentionAgent([])).toBeNull();
  });

  it("returns null when no agent requires attention", () => {
    expect(
      pickAttentionAgent([
        createAgent({ id: "agent-1", requiresAttention: false, attentionReason: "permission" }),
        createAgent({ id: "agent-2", requiresAttention: false, attentionReason: null }),
      ]),
    ).toBeNull();
  });

  it("returns the single permission agent", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "agent-1",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-03T00:00:00.000Z"),
        }),
      ]),
    ).toBe("agent-1");
  });

  it("prioritizes permission over error over finished", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "finished-agent",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
        createAgent({
          id: "error-agent",
          requiresAttention: true,
          attentionReason: "error",
          attentionTimestamp: new Date("2026-01-02T00:00:00.000Z"),
        }),
        createAgent({
          id: "permission-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-03T00:00:00.000Z"),
        }),
      ]),
    ).toBe("permission-agent");
  });

  it("breaks ties by oldest attention timestamp", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "newer-permission-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-03T00:00:00.000Z"),
        }),
        createAgent({
          id: "older-permission-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ]),
    ).toBe("older-permission-agent");
  });

  it("ignores subagents even when they require attention", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "subagent",
          parentAgentId: "parent-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
        createAgent({
          id: "top-level-agent",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ]),
    ).toBe("top-level-agent");
  });

  it("returns null when only subagents require attention", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "subagent",
          parentAgentId: "parent-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ]),
    ).toBeNull();
  });

  it("ignores agents with requiresAttention true but null reason", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "ignored-agent",
          requiresAttention: true,
          attentionReason: null,
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
        createAgent({
          id: "error-agent",
          requiresAttention: true,
          attentionReason: "error",
          attentionTimestamp: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ]),
    ).toBe("error-agent");
  });
});

describe("pickNextAttentionAgent", () => {
  const permissionOnHostB = createAgent({
    id: "permission-agent",
    serverId: "host-b",
    workspaceId: "workspace-b",
    pendingPermissions: [{ id: "permission-1", provider: "codex", name: "Bash", kind: "tool" }],
  });
  const errorOnHostA = createAgent({
    id: "error-agent",
    serverId: "host-a",
    workspaceId: "workspace-a1",
    requiresAttention: true,
    attentionReason: "error",
    attentionTimestamp: new Date("2026-01-02T00:00:00.000Z"),
  });
  const olderFinishedOnHostA = createAgent({
    id: "older-finished-agent",
    serverId: "host-a",
    workspaceId: "workspace-a2",
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
  });
  const newerFinishedOnHostB = createAgent({
    id: "newer-finished-agent",
    serverId: "host-b",
    workspaceId: "workspace-b",
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: new Date("2026-01-03T00:00:00.000Z"),
  });
  const quietAgent = createAgent({ id: "quiet-agent", serverId: "host-a" });
  const agents = [
    newerFinishedOnHostB,
    quietAgent,
    olderFinishedOnHostA,
    errorOnHostA,
    permissionOnHostB,
  ];

  function nextFrom(current: { serverId: string; agentId: string } | null) {
    return pickNextAttentionAgent({ agents, current })?.id ?? null;
  }

  it("crosses hosts and workspaces: permission, then error, then the oldest finished", () => {
    expect(nextFrom(null)).toBe("permission-agent");
    expect(nextFrom({ serverId: "host-b", agentId: "permission-agent" })).toBe("error-agent");
    expect(nextFrom({ serverId: "host-a", agentId: "error-agent" })).toBe("older-finished-agent");
    expect(nextFrom({ serverId: "host-a", agentId: "older-finished-agent" })).toBe(
      "newer-finished-agent",
    );
    expect(nextFrom({ serverId: "host-b", agentId: "newer-finished-agent" })).toBe(
      "permission-agent",
    );
  });

  it("starts from the top when the current agent needs nothing", () => {
    expect(nextFrom({ serverId: "host-a", agentId: "quiet-agent" })).toBe("permission-agent");
  });

  it("matches the current agent by host, not just by id", () => {
    expect(nextFrom({ serverId: "host-a", agentId: "permission-agent" })).toBe("permission-agent");
  });

  it("returns null when the only agent waiting is the one on screen", () => {
    expect(
      pickNextAttentionAgent({
        agents: [errorOnHostA, quietAgent],
        current: { serverId: "host-a", agentId: "error-agent" },
      }),
    ).toBeNull();
  });

  it("returns null when nothing needs attention", () => {
    expect(pickNextAttentionAgent({ agents: [quietAgent], current: null })).toBeNull();
  });

  it("skips subagents and archived agents", () => {
    expect(
      pickNextAttentionAgent({
        agents: [
          createAgent({
            id: "subagent",
            parentAgentId: "parent",
            requiresAttention: true,
            attentionReason: "permission",
          }),
          createAgent({
            id: "archived",
            archivedAt: new Date("2026-01-04T00:00:00.000Z"),
            requiresAttention: true,
            attentionReason: "error",
          }),
        ],
        current: null,
      }),
    ).toBeNull();
  });
});
