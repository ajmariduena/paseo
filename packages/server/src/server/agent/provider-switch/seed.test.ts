import { expect, test } from "vitest";

import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { ProviderIncarnation, ProviderSegment, ProviderSwitchRecordState } from "./record.js";
import { retiredSnapshotIds, SEED_BYTE_CAP, seedRetiredHistory } from "./seed.js";
import { buildSegmentSnapshot, type SegmentSnapshot } from "./snapshot-store.js";

const T0 = "2026-10-09T10:00:00.000Z";
const T1 = "2026-10-09T11:00:00.000Z";
const T2 = "2026-10-09T12:00:00.000Z";

function incarnation(
  id: string,
  overrides: Partial<ProviderIncarnation> = {},
): ProviderIncarnation {
  return {
    id,
    persistence: { provider: "claude", sessionId: `session-${id}` },
    startedAt: T0,
    endedAt: T1,
    reason: "switch",
    snapshotId: id,
    rowCount: 2,
    coverage: "complete",
    firstAcceptedAt: T0,
    unresolvedAttemptId: null,
    ...overrides,
  };
}

function segment(
  id: string,
  provider: string,
  incarnations: ProviderIncarnation[],
  overrides: Partial<ProviderSegment> = {},
): ProviderSegment {
  return {
    id,
    provider,
    model: `${provider}-model`,
    modeId: null,
    thinkingOptionId: null,
    incarnations,
    startedAt: T0,
    endedAt: T1,
    handoffId: `handoff-${id}`,
    requestedBy: "user",
    operationId: `op-${id}`,
    ...overrides,
  };
}

function row(seq: number, text: string): AgentTimelineRow {
  return { seq, timestamp: T0, item: { type: "assistant_message", text } };
}

function snapshot(
  segmentId: string,
  incarnationId: string,
  rows: AgentTimelineRow[],
): SegmentSnapshot {
  return buildSegmentSnapshot({
    agentId: "agent-1",
    segmentId,
    incarnationId,
    provider: "claude",
    model: null,
    rows,
    childPanes: [],
    sealedAt: T1,
  });
}

function twoSegmentState(): ProviderSwitchRecordState {
  return {
    providerSegments: [
      segment("seg-a", "claude", [incarnation("inc-a1")]),
      segment("seg-b", "codex", [incarnation("inc-b1", { endedAt: null, snapshotId: null })], {
        startedAt: T2,
        endedAt: null,
        handoffId: "handoff-b",
      }),
    ],
  };
}

test("retired snapshots become dense rows followed by the divider into the active segment", () => {
  const state = twoSegmentState();
  const snapshots = new Map([
    ["inc-a1", snapshot("seg-a", "inc-a1", [row(5, "hello"), row(9, "world")])],
  ]);

  const seeded = seedRetiredHistory({ state, snapshots, now: T2 });

  expect(retiredSnapshotIds(state)).toEqual(["inc-a1"]);
  expect(seeded.rows.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  expect(seeded.rows.map((entry) => entry.origin)).toEqual([
    { segmentId: "seg-a", incarnationId: "inc-a1", rowIndex: 0 },
    { segmentId: "seg-a", incarnationId: "inc-a1", rowIndex: 1 },
    undefined,
  ]);
  expect(seeded.rows[0].item).toEqual({ type: "assistant_message", text: "hello" });
  expect(seeded.rows[2]).toEqual({
    seq: 3,
    timestamp: T2,
    item: {
      type: "notification",
      level: "info",
      message: "Switched from claude to codex",
      providerSegment: {
        kind: "provider_switch",
        segmentId: "seg-b",
        fromProvider: "claude",
        toProvider: "codex",
        fromModel: "claude-model",
        toModel: "codex-model",
        handoffId: "handoff-b",
      },
    },
  });
  expect(seeded.gaps).toEqual([]);
  expect(seeded.bytes).toBeGreaterThan(0);
});

test("a missing snapshot file is one warning row with unavailable coverage", () => {
  const seeded = seedRetiredHistory({ state: twoSegmentState(), snapshots: new Map(), now: T2 });

  expect(seeded.rows.map((entry) => entry.item.type)).toEqual(["notification", "notification"]);
  expect(seeded.rows[0].item).toMatchObject({
    level: "warning",
    providerSegment: {
      kind: "retired_history",
      segmentId: "seg-a",
      incarnationId: "inc-a1",
      reason: "unavailable",
    },
  });
  expect(seeded.gaps).toEqual([
    { segmentId: "seg-a", incarnationId: "inc-a1", reason: "unavailable", rows: null },
  ]);
});

test("two incarnations of one segment keep distinct row identities", () => {
  const state: ProviderSwitchRecordState = {
    providerSegments: [
      segment(
        "seg-a",
        "claude",
        [
          incarnation("inc-a1"),
          incarnation("inc-a2", { reason: "uncertain_delivery", startedAt: T1 }),
          incarnation("inc-a3", { endedAt: null, snapshotId: null, startedAt: T2 }),
        ],
        { endedAt: null },
      ),
    ],
  };
  const snapshots = new Map([
    ["inc-a1", snapshot("seg-a", "inc-a1", [row(1, "from i1")])],
    ["inc-a2", snapshot("seg-a", "inc-a2", [row(1, "from i2")])],
  ]);

  const seeded = seedRetiredHistory({ state, snapshots, now: T2 });

  const texts = seeded.rows
    .filter((entry) => entry.item.type === "assistant_message")
    .map((entry) => [entry.item.type === "assistant_message" ? entry.item.text : "", entry.origin]);
  expect(texts).toEqual([
    ["from i1", { segmentId: "seg-a", incarnationId: "inc-a1", rowIndex: 0 }],
    ["from i2", { segmentId: "seg-a", incarnationId: "inc-a2", rowIndex: 0 }],
  ]);
});

test("seal-time drops surface as a warning row before the surviving rows", () => {
  const big = "x".repeat(1024 * 1024);
  const sealed = snapshot(
    "seg-a",
    "inc-a1",
    Array.from({ length: 10 }, (_, index) => row(index + 1, big)),
  );

  const seeded = seedRetiredHistory({
    state: twoSegmentState(),
    snapshots: new Map([["inc-a1", sealed]]),
    now: T2,
  });

  expect(seeded.rows[0].item).toMatchObject({
    type: "notification",
    providerSegment: { kind: "retired_history", reason: "dropped" },
  });
  expect(seeded.gaps).toEqual([
    {
      segmentId: "seg-a",
      incarnationId: "inc-a1",
      reason: "dropped",
      rows: { fromRowIndex: 0, toRowIndex: 2 },
    },
  ]);
  expect(seeded.rows).toHaveLength(1 + sealed.rows.length + 1);
});

test("the per-agent cap keeps the newest retired snapshots and warns about the oldest", () => {
  const sevenMiB = "z".repeat(7 * 1024 * 1024);
  const state: ProviderSwitchRecordState = {
    providerSegments: [
      segment("seg-a", "claude", [incarnation("inc-a1"), incarnation("inc-a2")]),
      segment("seg-b", "codex", [
        incarnation("inc-b1"),
        incarnation("inc-b2"),
        incarnation("inc-b3"),
      ]),
      segment("seg-c", "claude", [incarnation("inc-c1", { endedAt: null, snapshotId: null })], {
        endedAt: null,
      }),
    ],
  };
  const snapshots = new Map<string, SegmentSnapshot | null>();
  for (const [segmentId, incarnationId] of [
    ["seg-a", "inc-a1"],
    ["seg-a", "inc-a2"],
    ["seg-b", "inc-b1"],
    ["seg-b", "inc-b2"],
    ["seg-b", "inc-b3"],
  ] as const) {
    snapshots.set(incarnationId, snapshot(segmentId, incarnationId, [row(1, sevenMiB)]));
  }

  const seeded = seedRetiredHistory({ state, snapshots, now: T2 });

  expect(seeded.bytes).toBeLessThanOrEqual(SEED_BYTE_CAP);
  expect(seeded.gaps.map((gap) => `${gap.incarnationId}:${gap.reason}`)).toEqual([
    "inc-a1:over_cap",
  ]);
  const seededTexts = seeded.rows.filter((entry) => entry.item.type === "assistant_message");
  expect(seededTexts).toHaveLength(4);
  const dividers = seeded.rows.filter(
    (entry) =>
      entry.item.type === "notification" && entry.item.providerSegment?.kind === "provider_switch",
  );
  expect(dividers.map((entry) => entry.item.type === "notification" && entry.item.message)).toEqual(
    ["Switched from claude to codex", "Switched from codex to claude"],
  );
});

test("replaced incarnations get a marker row, including the active one", () => {
  const state: ProviderSwitchRecordState = {
    providerSegments: [
      segment(
        "seg-a",
        "claude",
        [
          incarnation("inc-a1", { snapshotId: "inc-a1" }),
          incarnation("inc-a2", {
            reason: "uncertain_delivery",
            snapshotId: "inc-a2",
            startedAt: T1,
          }),
          incarnation("inc-a3", {
            reason: "resume_failed",
            endedAt: null,
            snapshotId: null,
            startedAt: T2,
          }),
        ],
        { endedAt: null },
      ),
    ],
  };
  const snapshots = new Map([
    ["inc-a1", snapshot("seg-a", "inc-a1", [row(1, "one")])],
    ["inc-a2", snapshot("seg-a", "inc-a2", [row(1, "two")])],
  ]);

  const seeded = seedRetiredHistory({ state, snapshots, now: T2 });

  expect(
    seeded.rows.map((entry) =>
      entry.item.type === "notification" ? entry.item.providerSegment?.kind : entry.item.text,
    ),
  ).toEqual(["one", "incarnation", "two", "incarnation"]);
  expect(seeded.rows[1].item).toMatchObject({
    providerSegment: { kind: "incarnation", incarnationId: "inc-a2", reason: "uncertain_delivery" },
  });
  expect(seeded.rows[3].item).toMatchObject({
    providerSegment: { kind: "incarnation", incarnationId: "inc-a3", reason: "resume_failed" },
  });
});

test("an agent without segments seeds nothing", () => {
  expect(seedRetiredHistory({ state: {}, snapshots: new Map(), now: T2 })).toEqual({
    rows: [],
    gaps: [],
    bytes: 0,
  });
});
