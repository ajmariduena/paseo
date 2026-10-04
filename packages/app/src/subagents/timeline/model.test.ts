import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { ToolCallItem } from "@/types/stream";
import { resolveSpawnGroupLiveSince, resolveSpawnRow, type SpawnedAgentSnapshot } from "./model";
import { readSubagentSpawnCall, type SubagentSpawnCall } from "./spawn-call";

function toolCall(
  id: string,
  input: {
    name: string;
    detail: ToolCallDetail;
    status?: "running" | "completed" | "failed" | "canceled";
  },
): ToolCallItem {
  const status = input.status ?? "completed";
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(`2026-10-04T10:00:0${id}.000Z`),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: `call_${id}`,
        name: input.name,
        status,
        error: status === "failed" ? "boom" : null,
        detail: input.detail,
      },
    },
  };
}

function createAgentCall(
  id: string,
  options: { agentId?: string; status?: "running" | "completed" | "failed" } = {},
): ToolCallItem {
  return toolCall(id, {
    name: "mcp__paseo__create_agent",
    status: options.status,
    detail: {
      type: "unknown",
      input: { title: "Review diff panel", provider: "codex/gpt-5.4", initialPrompt: "Go" },
      output: options.agentId
        ? { content: [{ type: "text", text: JSON.stringify({ agentId: options.agentId }) }] }
        : null,
    },
  });
}

function agent(overrides: Partial<SpawnedAgentSnapshot> = {}): SpawnedAgentSnapshot {
  return {
    id: "agt_child",
    provider: "codex",
    title: "Sol: diff performance",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-10-04T10:00:02.000Z"),
    pendingPermissions: [],
    requiresAttention: false,
    attentionReason: null,
    archivedAt: null,
    model: "gpt-6.1-sol",
    runtimeInfo: undefined,
    ...overrides,
  };
}

function descriptor(
  overrides: Partial<ProviderSubagentDescriptorPayload> = {},
): ProviderSubagentDescriptorPayload {
  return {
    id: "sub_1",
    parentAgentId: "agt_parent",
    provider: "claude",
    title: "Explore",
    description: "Map the diff pane layout",
    status: "running",
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:34.000Z",
    toolCallId: "call_1",
    subtitle: "Explore · Sonnet 5",
    ...overrides,
  };
}

function spawnOf(item: ToolCallItem): SubagentSpawnCall {
  const spawn = readSubagentSpawnCall(item);
  if (!spawn) throw new Error("Expected a spawn call");
  return spawn;
}

describe("readSubagentSpawnCall", () => {
  it("reads the created agent and its title from a completed create_agent", () => {
    expect(readSubagentSpawnCall(createAgentCall("1", { agentId: "agt_child" }))).toEqual({
      kind: "paseo",
      callId: "call_1",
      status: "completed",
      agentId: "agt_child",
      title: "Review diff panel",
      provider: "codex",
    });
  });

  it("reads the created agent from Claude's parsed output envelope", () => {
    const call = toolCall("1", {
      name: "mcp__paseo__create_agent",
      detail: {
        type: "unknown",
        input: { title: "Haiku A", provider: "claude/claude-haiku-4-5", initialPrompt: "Go" },
        output: {
          output: {
            agentId: "12f4881e-4be0-45ec-b149-260a3d9ec66f",
            type: "claude",
            status: "running",
            currentModeId: "default",
          },
        },
      },
    });
    expect(readSubagentSpawnCall(call)).toEqual({
      kind: "paseo",
      callId: "call_1",
      status: "completed",
      agentId: "12f4881e-4be0-45ec-b149-260a3d9ec66f",
      title: "Haiku A",
      provider: "claude",
    });
  });

  it("keeps a running create_agent as a spawn without an agent yet", () => {
    expect(readSubagentSpawnCall(createAgentCall("1", { status: "running" }))).toMatchObject({
      kind: "paseo",
      agentId: null,
    });
  });

  it("leaves failed spawns and spawns without a readable agent as tool calls", () => {
    expect(readSubagentSpawnCall(createAgentCall("1", { status: "failed" }))).toBeNull();
    expect(readSubagentSpawnCall(createAgentCall("2"))).toBeNull();
  });

  it("treats a provider sub_agent call as a spawn", () => {
    expect(
      readSubagentSpawnCall(
        toolCall("1", {
          name: "Task",
          status: "running",
          detail: { type: "sub_agent", subAgentType: "Explore", description: "Map it", log: "" },
        }),
      ),
    ).toEqual({ kind: "provider", callId: "call_1", status: "running", title: "Map it" });
  });

  it("ignores other Paseo tools", () => {
    expect(
      readSubagentSpawnCall(
        toolCall("1", {
          name: "mcp__paseo__send_agent_prompt",
          detail: { type: "unknown", input: { agentId: "agt_child" }, output: null },
        }),
      ),
    ).toBeNull();
  });
});

describe("resolveSpawnRow", () => {
  it("draws a Paseo child from the session store", () => {
    const startedAt = new Date("2026-10-04T10:01:00.000Z");
    const row = resolveSpawnRow({
      spawn: spawnOf(createAgentCall("1", { agentId: "agt_child" })),
      agent: agent({
        status: "running",
        turn: { phase: "open", turnId: "t1", startedAt, cancellationRequestId: null },
      }),
      descriptor: null,
      providerEntries: undefined,
    });
    expect(row).toEqual({
      key: "call_1",
      provider: "codex",
      title: "Sol: diff performance",
      status: { word: "working", bucket: "running", isLive: true },
      liveSince: startedAt,
      settledDurationMs: null,
      modelLabel: "gpt-6.1-sol",
      target: { kind: "agent", agentId: "agt_child" },
    });
  });

  it("falls back to the call's own title and reads archived once the child is gone", () => {
    const row = resolveSpawnRow({
      spawn: spawnOf(createAgentCall("1", { agentId: "agt_gone" })),
      agent: null,
      descriptor: null,
      providerEntries: undefined,
    });
    expect(row).toMatchObject({
      title: "Review diff panel",
      status: { word: "archived", isLive: false },
      liveSince: null,
      target: { kind: "agent", agentId: "agt_gone" },
    });
  });

  it("is not openable while the child is still being created", () => {
    const row = resolveSpawnRow({
      spawn: spawnOf(createAgentCall("1", { status: "running" })),
      agent: null,
      descriptor: null,
      providerEntries: undefined,
    });
    expect(row).toMatchObject({ status: { word: "starting" }, target: null });
  });

  it("draws a provider child from its descriptor and freezes its duration once settled", () => {
    const spawn = spawnOf(
      toolCall("1", {
        name: "Task",
        detail: { type: "sub_agent", subAgentType: "Explore", log: "" },
      }),
    );
    const live = resolveSpawnRow({
      spawn,
      agent: null,
      descriptor: descriptor(),
      providerEntries: undefined,
    });
    expect(live).toMatchObject({
      provider: "claude",
      title: "Map the diff pane layout",
      status: { word: "working" },
      liveSince: new Date("2026-10-04T10:00:00.000Z"),
      modelLabel: "Explore · Sonnet 5",
      target: { kind: "provider_subagent", parentAgentId: "agt_parent", subagentId: "sub_1" },
    });

    const settled = resolveSpawnRow({
      spawn,
      agent: null,
      descriptor: descriptor({ status: "completed" }),
      providerEntries: undefined,
    });
    expect(settled).toMatchObject({
      status: { word: "done" },
      liveSince: null,
      settledDurationMs: 34_000,
    });
  });

  it("keeps a provider call without a descriptor visible but not openable", () => {
    const row = resolveSpawnRow({
      spawn: spawnOf(
        toolCall("1", {
          name: "Task",
          status: "running",
          detail: { type: "sub_agent", description: "Map it", log: "" },
        }),
      ),
      agent: null,
      descriptor: null,
      providerEntries: undefined,
    });
    expect(row).toMatchObject({ title: "Map it", status: { word: "working" }, target: null });
  });
});

describe("resolveSpawnGroupLiveSince", () => {
  it("times a live group from its first spawn and stops once every child settles", () => {
    const calls = [createAgentCall("1", { agentId: "a" }), createAgentCall("2", { agentId: "b" })];
    const live = resolveSpawnRow({
      spawn: spawnOf(calls[0]!),
      agent: agent({ status: "running" }),
      descriptor: null,
      providerEntries: undefined,
    });
    const done = resolveSpawnRow({
      spawn: spawnOf(calls[1]!),
      agent: agent(),
      descriptor: null,
      providerEntries: undefined,
    });

    expect(resolveSpawnGroupLiveSince({ rows: [live, done], calls })).toEqual(calls[0]!.timestamp);
    expect(resolveSpawnGroupLiveSince({ rows: [done, done], calls })).toBeNull();
  });
});
