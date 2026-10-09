import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { ProviderSubagentDescriptor } from "../provider-subagents/store.js";
import {
  buildSegmentSnapshot,
  CHILD_PANE_BYTE_CAP,
  CHILD_PANE_COUNT_CAP,
  SegmentSnapshotStore,
  SNAPSHOT_BYTE_CAP,
  SnapshotAlreadySealedError,
  SnapshotTooLargeError,
  type SealSnapshotInput,
} from "./snapshot-store.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "segment-snapshots-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const NOW = "2026-10-09T12:00:00.000Z";

function row(seq: number, text: string): AgentTimelineRow {
  return { seq, timestamp: NOW, item: { type: "assistant_message", text, messageId: `m${seq}` } };
}

function toolRow(seq: number, callId: string): AgentTimelineRow {
  return {
    seq,
    timestamp: NOW,
    item: {
      type: "tool_call",
      callId,
      name: "Read",
      status: "completed",
      detail: { type: "generic", input: null, output: null },
    },
    turnId: "turn-1",
  };
}

function descriptor(id: string): ProviderSubagentDescriptor {
  return {
    id,
    parentAgentId: "agent-1",
    parentSubagentId: null,
    provider: "claude",
    title: `Child ${id}`,
    description: null,
    status: "completed",
    createdAt: NOW,
    updatedAt: NOW,
    toolCallId: null,
    cwd: null,
  };
}

function sealInput(overrides: Partial<SealSnapshotInput> = {}): SealSnapshotInput {
  return {
    agentId: "agent-1",
    segmentId: "seg-a",
    incarnationId: "inc-a1",
    provider: "claude",
    model: "claude-opus-5-5",
    rows: [row(7, "first"), toolRow(9, "call-1"), row(12, "last")],
    childPanes: [],
    sealedAt: NOW,
    ...overrides,
  };
}

test("sealing renumbers rows densely, namespaces native ids and writes once", async () => {
  const store = new SegmentSnapshotStore(root);

  const sealed = await store.seal(sealInput());

  expect(sealed.rows.map((entry) => entry.identity)).toEqual([
    { segmentId: "seg-a", incarnationId: "inc-a1", rowIndex: 0 },
    { segmentId: "seg-a", incarnationId: "inc-a1", rowIndex: 1 },
    { segmentId: "seg-a", incarnationId: "inc-a1", rowIndex: 2 },
  ]);
  expect(sealed.rows[1]).toMatchObject({
    item: { type: "tool_call", callId: "inc-a1:call-1" },
    turnId: "turn-1",
  });
  expect(sealed.rows[0].item).toMatchObject({ messageId: "inc-a1:m7" });
  expect(sealed.coverage).toBe("complete");
  expect(sealed.droppedRanges).toEqual([]);
  expect(JSON.parse(readFileSync(join(root, "agent-1", "inc-a1.json"), "utf8"))).toEqual(sealed);
  expect(readdirSync(join(root, "agent-1"))).toEqual(["inc-a1.json"]);

  await expect(store.seal(sealInput({ rows: [] }))).rejects.toBeInstanceOf(
    SnapshotAlreadySealedError,
  );
  expect(await store.read("agent-1", "inc-a1")).toEqual(sealed);
  expect(await store.listIncarnations("agent-1")).toEqual(["inc-a1"]);
  expect(await store.listAgents()).toEqual(["agent-1"]);
});

test("a missing snapshot reads as null", async () => {
  const store = new SegmentSnapshotStore(root);
  expect(await store.read("agent-1", "nope")).toBeNull();
  expect(await store.listIncarnations("agent-1")).toEqual([]);
});

test("the 8 MiB cap drops the oldest rows at seal time and records the range once", () => {
  const big = "x".repeat(1024 * 1024);
  const rows = Array.from({ length: 10 }, (_, index) => row(index + 1, big));

  const sealed = buildSegmentSnapshot(sealInput({ rows }));

  expect(Buffer.byteLength(JSON.stringify(sealed), "utf8")).toBeLessThanOrEqual(SNAPSHOT_BYTE_CAP);
  expect(sealed.coverage).toBe("truncated");
  expect(sealed.droppedRanges).toEqual([{ fromRowIndex: 0, toRowIndex: 2 }]);
  expect(sealed.rows[0].identity.rowIndex).toBe(3);
  expect(sealed.rows).toHaveLength(7);
});

test("child panes lose their rows before the parent transcript loses any", () => {
  const parentRows = Array.from({ length: 15 }, (_, index) =>
    row(index + 1, "x".repeat(520 * 1024)),
  );
  const childRows = [row(1, "y".repeat(500 * 1024))];

  const sealed = buildSegmentSnapshot(
    sealInput({
      rows: parentRows,
      childPanes: [{ descriptor: descriptor("c1"), rows: childRows }],
    }),
  );

  expect(sealed.coverage).toBe("complete");
  expect(sealed.rows).toHaveLength(15);
  expect(sealed.childPanes).toEqual([
    { descriptor: descriptor("c1"), rows: null, droppedRanges: [] },
  ]);
  expect(sealed.childPanesNotice).toBe("over_cap");
});

test("a child pane keeps at most 512 KiB, dropping its oldest rows", () => {
  const chunk = "y".repeat(200 * 1024);
  const sealed = buildSegmentSnapshot(
    sealInput({
      rows: [row(1, "parent")],
      childPanes: [
        { descriptor: descriptor("c1"), rows: [row(1, chunk), row(2, chunk), row(3, chunk)] },
      ],
    }),
  );

  expect(sealed.childPanesNotice).toBeNull();
  expect(sealed.childPanes[0].rows?.map((entry) => entry.identity.rowIndex)).toEqual([1, 2]);
  expect(sealed.childPanes[0].droppedRanges).toEqual([{ fromRowIndex: 0, toRowIndex: 0 }]);
  expect(sealed.childPanes[0].rows?.[0].item).toMatchObject({ messageId: "inc-a1:m2" });
});

test("only 32 children keep rows; the rest keep their descriptor", () => {
  const panes = Array.from({ length: CHILD_PANE_COUNT_CAP + 1 }, (_, index) => ({
    descriptor: descriptor(`c${index}`),
    rows: [row(1, `child ${index}`)],
  }));

  const sealed = buildSegmentSnapshot(sealInput({ rows: [row(1, "parent")], childPanes: panes }));

  expect(sealed.childPanesNotice).toBe("too_many");
  expect(sealed.childPanes[0].rows).toHaveLength(1);
  expect(sealed.childPanes[CHILD_PANE_COUNT_CAP - 1].rows).toHaveLength(1);
  expect(sealed.childPanes[CHILD_PANE_COUNT_CAP]).toEqual({
    descriptor: descriptor(`c${CHILD_PANE_COUNT_CAP}`),
    rows: null,
    droppedRanges: [],
  });
});

test("deleting an agent's snapshots removes the directory", async () => {
  const store = new SegmentSnapshotStore(root);
  await store.seal(sealInput());
  await store.seal(sealInput({ incarnationId: "inc-a2" }));

  await store.delete("agent-1", "inc-a1");
  expect(await store.listIncarnations("agent-1")).toEqual(["inc-a2"]);
  await store.deleteAgent("agent-1");
  expect(await store.listAgents()).toEqual([]);
});

test("concurrent seals of one incarnation publish exactly one file", async () => {
  const store = new SegmentSnapshotStore(root);
  const other = new SegmentSnapshotStore(root);

  const results = await Promise.allSettled([
    store.seal(sealInput({ rows: [row(1, "first")] })),
    other.seal(sealInput({ rows: [row(1, "second")] })),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].status === "rejected" && rejected[0].reason).toBeInstanceOf(
    SnapshotAlreadySealedError,
  );
  const onDisk = JSON.parse(readFileSync(join(root, "agent-1", "inc-a1.json"), "utf8"));
  expect(fulfilled[0].status === "fulfilled" && fulfilled[0].value).toEqual(onDisk);
});

test("the 8 MiB cap bounds the file as written, with many small rows", async () => {
  const store = new SegmentSnapshotStore(root);
  const rows = Array.from({ length: 40_000 }, (_, index) =>
    row(index + 1, `assistant line ${index} ${"x".repeat(160)}`),
  );

  const sealed = await store.seal(sealInput({ rows }));

  expect(statSync(join(root, "agent-1", "inc-a1.json")).size).toBeLessThanOrEqual(
    SNAPSHOT_BYTE_CAP,
  );
  expect(sealed.coverage).toBe("truncated");
  expect(sealed.rows.length).toBeGreaterThan(10_000);
  expect(sealed.droppedRanges).toEqual([
    { fromRowIndex: 0, toRowIndex: 40_000 - sealed.rows.length - 1 },
  ]);
});

test("descriptors that alone exceed the cap drop the child panes, and a bare envelope over the cap refuses to seal", () => {
  const hugeDescriptor = { ...descriptor("c1"), description: "d".repeat(9 * 1024 * 1024) };

  const sealed = buildSegmentSnapshot(
    sealInput({ rows: [row(1, "parent")], childPanes: [{ descriptor: hugeDescriptor, rows: [] }] }),
  );
  expect(sealed.childPanes).toEqual([]);
  expect(sealed.childPanesNotice).toBe("over_cap");
  expect(sealed.rows).toHaveLength(1);

  expect(() =>
    buildSegmentSnapshot(sealInput({ rows: [], model: "m".repeat(9 * 1024 * 1024) })),
  ).toThrow(SnapshotTooLargeError);
});

/** The child pane object exactly as it sits inside the written file. */
function nestedPaneBytes(snapshot: ReturnType<typeof buildSegmentSnapshot>): number {
  const text = JSON.stringify(snapshot, null, 2);
  const start = text.indexOf("    {", text.indexOf('"childPanes": ['));
  const end = text.indexOf("\n    }", start) + "\n    }".length;
  return Buffer.byteLength(text.slice(start, end), "utf8");
}

test("the 512 KiB child cap bounds the pane as it is nested in the file", () => {
  const rows = Array.from({ length: 5_000 }, (_, index) => row(index + 1, `child line ${index}`));

  const sealed = buildSegmentSnapshot(
    sealInput({ rows: [row(1, "parent")], childPanes: [{ descriptor: descriptor("c1"), rows }] }),
  );

  expect(sealed.childPanes[0].rows?.length).toBeGreaterThan(1_000);
  expect(nestedPaneBytes(sealed)).toBeLessThanOrEqual(CHILD_PANE_BYTE_CAP);
  expect(sealed.childPanes[0].droppedRanges).toEqual([
    { fromRowIndex: 0, toRowIndex: 5_000 - (sealed.childPanes[0].rows?.length ?? 0) - 1 },
  ]);
});

test("a child whose descriptor alone exceeds its cap keeps the descriptor and reports no drop", () => {
  const heavy = { ...descriptor("c1"), description: "d".repeat(600 * 1024) };

  const sealed = buildSegmentSnapshot(
    sealInput({ rows: [row(1, "parent")], childPanes: [{ descriptor: heavy, rows: [] }] }),
  );

  expect(sealed.childPanes).toEqual([{ descriptor: heavy, rows: null, droppedRanges: [] }]);
  expect(sealed.childPanesNotice).toBe("over_cap");
});

test("a snapshot file that is not complete JSON reads as unavailable, not as a seal", async () => {
  const store = new SegmentSnapshotStore(root);
  mkdirSync(join(root, "agent-1"), { recursive: true });
  writeFileSync(join(root, "agent-1", "inc-a1.json"), '{"version": 1, "rows": [');

  expect(await store.read("agent-1", "inc-a1")).toBeNull();
});
