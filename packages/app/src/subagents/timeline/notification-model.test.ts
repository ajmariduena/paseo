import { describe, expect, it } from "vitest";
import type {
  NotificationSource,
  ProviderSnapshotEntry,
  SubagentNotificationEntry,
} from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";
import type { SpawnedAgentSnapshot } from "./model";
import { resolveSubagentNotificationRows } from "./notification-model";
import { isSubagentNotification, readSubagentNotificationEntries } from "./notification-source";

function agent(overrides: Partial<SpawnedAgentSnapshot> = {}): SpawnedAgentSnapshot {
  return {
    id: "agt_child",
    provider: "claude",
    title: "Fable: diff panel UX review",
    status: "running",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-10-04T10:00:00.000Z"),
    pendingPermissions: [],
    requiresAttention: false,
    attentionReason: null,
    archivedAt: null,
    model: "fable-5.1",
    runtimeInfo: undefined,
    ...overrides,
  };
}

const providerEntries: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    label: "claude-personal",
    source: "custom",
    models: [{ provider: "claude", id: "fable-5.1", label: "Fable 5.1" }],
  },
];

function notification(source?: NotificationSource): StreamItem {
  return {
    kind: "notification",
    sourceType: "notification",
    id: "notification:wake-1",
    timestamp: new Date("2026-10-04T10:03:12.000Z"),
    level: "info",
    message: "Fable: diff panel UX review finished",
    ...(source ? { source } : {}),
  };
}

describe("subagent notifications", () => {
  it("recognizes only notifications that name subagents", () => {
    const wake = notification({
      kind: "subagent",
      subagents: [{ agentId: "agt_child", reason: "finished" }],
    });
    expect(isSubagentNotification(wake)).toBe(true);
    expect(readSubagentNotificationEntries(wake)).toEqual([
      { agentId: "agt_child", reason: "finished" },
    ]);
    expect(isSubagentNotification(notification())).toBe(false);
    expect(isSubagentNotification(notification({ kind: "subagent", subagents: [] }))).toBe(false);
  });

  it("freezes each reason's word and dot, whatever the child does next", () => {
    const entries: SubagentNotificationEntry[] = [
      { agentId: "a", reason: "finished", durationMs: 192_000 },
      { agentId: "b", reason: "errored" },
      { agentId: "c", reason: "needs_permission" },
      { agentId: "d", reason: "closed" },
    ];
    const rows = resolveSubagentNotificationRows({
      notificationId: "n1",
      entries,
      agents: [agent({ status: "running" }), null, null, null],
      providerEntries,
    });
    expect(rows.map((row) => [row.word, row.bucket, row.durationMs])).toEqual([
      ["finished", "attention", 192_000],
      ["failed", "failed", null],
      ["needsInput", "needs_input", null],
      ["closed", "done", null],
    ]);
  });

  it("reads title, provider and model label from the live child", () => {
    const [row] = resolveSubagentNotificationRows({
      notificationId: "n1",
      entries: [{ agentId: "agt_child", reason: "finished", title: "Old title" }],
      agents: [agent()],
      providerEntries,
    });
    expect(row).toEqual({
      key: "n1:0:agt_child",
      agentId: "agt_child",
      provider: "claude",
      title: "Fable: diff panel UX review",
      word: "finished",
      bucket: "attention",
      durationMs: null,
      modelLabel: "Fable 5.1 · claude-personal",
      target: { kind: "agent", agentId: "agt_child" },
    });
  });

  it("falls back to the notification's own copy when the child is gone, and still opens it", () => {
    const [row] = resolveSubagentNotificationRows({
      notificationId: "n1",
      entries: [{ agentId: "agt_gone", reason: "errored", title: "  Sol: perf edge cases " }],
      agents: [null],
      providerEntries,
    });
    expect(row).toEqual({
      key: "n1:0:agt_gone",
      agentId: "agt_gone",
      provider: null,
      title: "Sol: perf edge cases",
      word: "failed",
      bucket: "failed",
      durationMs: null,
      modelLabel: null,
      target: { kind: "agent", agentId: "agt_gone" },
    });
  });

  it("draws every child of a batched wake, in the daemon's order", () => {
    const rows = resolveSubagentNotificationRows({
      notificationId: "n1",
      entries: [
        { agentId: "a", reason: "finished", title: "First" },
        { agentId: "b", reason: "finished", title: "Second" },
        { agentId: "c", reason: "closed", title: "Third" },
      ],
      agents: [null, null, null],
      providerEntries: undefined,
    });
    expect(rows.map((row) => [row.key, row.title, row.word])).toEqual([
      ["n1:0:a", "First", "finished"],
      ["n1:1:b", "Second", "finished"],
      ["n1:2:c", "Third", "closed"],
    ]);
  });
});
