import { describe, expect, it } from "vitest";
import type { PaseoSubagentRow, ProviderSubagentRow } from "@/subagents/select";
import { buildLineageSections, LINEAGE_PAGE_SIZE, pageLineageRows, type LineageRow } from "./model";

function paseo(
  id: string,
  createdAt: string,
  overrides: Partial<PaseoSubagentRow> = {},
): PaseoSubagentRow {
  return {
    kind: "paseo",
    id,
    provider: "codex",
    title: `Child ${id}`,
    description: null,
    subtitle: null,
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    requiresAttention: false,
    lastTurnOutcome: undefined,
    createdAt: new Date(createdAt),
    model: null,
    thinkingOptionId: null,
    ...overrides,
  };
}

function provider(
  id: string,
  createdAt: string,
  status: ProviderSubagentRow["status"],
): ProviderSubagentRow {
  return {
    kind: "provider",
    id,
    parentAgentId: "agt_self",
    provider: "claude",
    title: "Explore",
    description: `Task ${id}`,
    subtitle: null,
    status,
    requiresAttention: false,
    createdAt: new Date(createdAt),
    updatedAt: new Date(new Date(createdAt).getTime() + 34_000),
  };
}

const OPEN_TURN = {
  phase: "open",
  turnId: "t2",
  startedAt: new Date("2026-10-04T11:00:00.000Z"),
  cancellationRequestId: null,
} as const;

function keys(rows: readonly LineageRow[]): string[] {
  return rows.map((row) => row.key);
}

describe("buildLineageSections", () => {
  it("keeps live and unread children up front and the rest under previous subagents", () => {
    const sections = buildLineageSections({
      parent: null,
      children: [
        paseo("working", "2026-10-04T10:00:00.000Z", { status: "running", turn: OPEN_TURN }),
        paseo("unread", "2026-10-04T10:01:00.000Z", { requiresAttention: true }),
        paseo("read", "2026-10-04T10:02:00.000Z"),
        paseo("broken", "2026-10-04T10:03:00.000Z", { status: "error" }),
        provider("native", "2026-10-04T10:04:00.000Z", "running"),
      ],
      archived: null,
    });

    expect(keys(sections.subagents)).toEqual(["provider:native", "paseo:unread", "paseo:working"]);
    expect(keys(sections.previous)).toEqual(["paseo:broken", "paseo:read"]);
    expect(sections.previousFailedCount).toBe(1);
    expect(sections.runningCount).toBe(2);
  });

  it("files a child the user stopped under previous subagents as stopped", () => {
    const sections = buildLineageSections({
      parent: null,
      children: [
        paseo("stopped", "2026-10-04T10:00:00.000Z", { lastTurnOutcome: "canceled" }),
        paseo("done", "2026-10-04T10:01:00.000Z", { lastTurnOutcome: "completed" }),
      ],
      archived: null,
    });

    expect(sections.subagents).toEqual([]);
    expect(sections.previous.map((row) => [row.key, row.status])).toEqual([
      ["paseo:done", { word: "done", bucket: "done", isLive: false }],
      ["paseo:stopped", { word: "stopped", bucket: "done", isLive: false }],
    ]);
    expect(sections.previousFailedCount).toBe(0);
  });

  it("lets only running Paseo-owned children be stopped", () => {
    const sections = buildLineageSections({
      parent: null,
      children: [
        paseo("working", "2026-10-04T10:00:00.000Z", { status: "running", turn: OPEN_TURN }),
        paseo("unread", "2026-10-04T10:01:00.000Z", { requiresAttention: true }),
        provider("native", "2026-10-04T10:02:00.000Z", "running"),
      ],
      archived: [
        {
          id: "gone",
          provider: "codex",
          title: "Gone",
          createdAt: "2026-10-04T09:00:00.000Z",
          archivedAt: "2026-10-04T09:30:00.000Z",
        },
      ],
    });

    const stoppable = [...sections.subagents, ...sections.previous].map((row) => [
      row.key,
      row.canStop,
    ]);
    expect(stoppable).toEqual([
      ["provider:native", false],
      ["paseo:unread", false],
      ["paseo:working", true],
      ["paseo:gone", false],
    ]);
  });

  it("does not move a child when it starts working again, and restarts its timer", () => {
    const children = [
      paseo("a", "2026-10-04T10:00:00.000Z", { requiresAttention: true }),
      paseo("b", "2026-10-04T10:01:00.000Z", { requiresAttention: true }),
    ];
    const before = buildLineageSections({ parent: null, children, archived: null });
    const after = buildLineageSections({
      parent: null,
      children: [{ ...children[0]!, status: "running", turn: OPEN_TURN }, children[1]!],
      archived: null,
    });

    expect(keys(after.subagents)).toEqual(keys(before.subagents));
    expect(after.subagents[1]).toMatchObject({
      key: "paseo:a",
      status: { word: "working" },
      liveSince: OPEN_TURN.startedAt,
    });
  });

  it("adds archived children to previous subagents once, without repeating live ones", () => {
    const sections = buildLineageSections({
      parent: null,
      children: [paseo("kept", "2026-10-04T10:00:00.000Z")],
      archived: [
        {
          id: "gone",
          provider: "claude",
          title: "Old child",
          createdAt: "2026-10-04T09:00:00.000Z",
          archivedAt: "2026-10-04T09:30:00.000Z",
        },
        {
          id: "kept",
          provider: "codex",
          title: "Child kept",
          createdAt: "2026-10-04T10:00:00.000Z",
          archivedAt: "2026-10-04T10:30:00.000Z",
        },
      ],
    });

    expect(keys(sections.previous)).toEqual(["paseo:kept", "paseo:gone"]);
    expect(sections.previous[1]).toMatchObject({
      title: "Old child",
      status: { word: "archived" },
      target: { kind: "agent", agentId: "gone" },
    });
  });

  it("opens provider children as provider subagent tabs", () => {
    const sections = buildLineageSections({
      parent: null,
      children: [provider("native", "2026-10-04T10:04:00.000Z", "completed")],
      archived: null,
    });
    expect(sections.previous[0]).toMatchObject({
      title: "Task native",
      settledDurationMs: 34_000,
      target: { kind: "provider_subagent", parentAgentId: "agt_self", subagentId: "native" },
    });
  });
});

describe("pageLineageRows", () => {
  const rows = buildLineageSections({
    parent: null,
    children: Array.from({ length: 20 }, (_, index) =>
      paseo(`c${index}`, `2026-10-04T10:${String(index).padStart(2, "0")}:00.000Z`, {
        status: "running",
        turn: OPEN_TURN,
      }),
    ),
    archived: null,
  }).subagents;

  it("shows six rows, then offers up to twelve more", () => {
    const first = pageLineageRows(rows, LINEAGE_PAGE_SIZE);
    expect(first.visible).toHaveLength(6);
    expect(first.nextCount).toBe(12);

    const second = pageLineageRows(rows, LINEAGE_PAGE_SIZE + first.nextCount);
    expect(second.visible).toHaveLength(18);
    expect(second.nextCount).toBe(2);

    expect(pageLineageRows(rows, 20).nextCount).toBe(0);
  });
});
