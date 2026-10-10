import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  formatSubagentStatusCount,
  formatSubagentStatusWord,
  resolvePaseoSubagentStatus,
  resolveProviderSubagentStatus,
  resolveSpawnCallStatus,
  summarizeSubagentStatuses,
  type PaseoSubagentStatusInput,
} from "./status";

function paseo(overrides: Partial<PaseoSubagentStatusInput> = {}): PaseoSubagentStatusInput {
  return {
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    lastTurnOutcome: null,
    isArchived: false,
    ...overrides,
  };
}

const OPEN_TURN = {
  phase: "open",
  turnId: "t1",
  startedAt: new Date("2026-10-04T10:00:00.000Z"),
  cancellationRequestId: null,
} as const;

describe("resolvePaseoSubagentStatus", () => {
  it("reads an open turn as working, even when the snapshot still says idle", () => {
    expect(resolvePaseoSubagentStatus(paseo({ turn: OPEN_TURN }))).toEqual({
      word: "working",
      bucket: "running",
      isLive: true,
    });
  });

  it("reads a child still being created as starting", () => {
    expect(resolvePaseoSubagentStatus(paseo({ status: "initializing" }))).toEqual({
      word: "starting",
      bucket: "running",
      isLive: true,
    });
  });

  it("puts a pending permission ahead of the running turn", () => {
    expect(
      resolvePaseoSubagentStatus(
        paseo({ status: "running", turn: OPEN_TURN, pendingPermissionCount: 1 }),
      ),
    ).toEqual({ word: "needsInput", bucket: "needs_input", isLive: true });
  });

  it("reads an errored child as failed", () => {
    expect(resolvePaseoSubagentStatus(paseo({ status: "error" }))).toEqual({
      word: "failed",
      bucket: "failed",
      isLive: false,
    });
  });

  it("says done for an unread finished child and lets the dot carry the attention", () => {
    expect(
      resolvePaseoSubagentStatus(paseo({ requiresAttention: true, attentionReason: "finished" })),
    ).toEqual({ word: "done", bucket: "attention", isLive: false });
    expect(resolvePaseoSubagentStatus(paseo())).toEqual({
      word: "done",
      bucket: "done",
      isLive: false,
    });
  });

  it("says stopped, with a neutral dot, for a child whose turn was canceled", () => {
    expect(resolvePaseoSubagentStatus(paseo({ lastTurnOutcome: "canceled" }))).toEqual(
      resolveProviderSubagentStatus("canceled"),
    );
    expect(
      resolvePaseoSubagentStatus(
        paseo({
          lastTurnOutcome: "canceled",
          requiresAttention: true,
          attentionReason: "finished",
        }),
      ),
    ).toEqual({ word: "stopped", bucket: "done", isLive: false });
    expect(
      resolvePaseoSubagentStatus(paseo({ lastTurnOutcome: "canceled", turn: OPEN_TURN })).word,
    ).toBe("working");
    expect(resolvePaseoSubagentStatus(paseo({ lastTurnOutcome: "completed" })).word).toBe("done");
  });

  it("reads an archived or missing child as archived", () => {
    expect(resolvePaseoSubagentStatus(paseo({ isArchived: true })).word).toBe("archived");
    expect(resolvePaseoSubagentStatus(null)).toEqual({
      word: "archived",
      bucket: "done",
      isLive: false,
    });
  });
});

describe("resolveProviderSubagentStatus", () => {
  it("maps every descriptor status", () => {
    expect(resolveProviderSubagentStatus("running").word).toBe("working");
    expect(resolveProviderSubagentStatus("completed").word).toBe("done");
    expect(resolveProviderSubagentStatus("failed").word).toBe("failed");
    expect(resolveProviderSubagentStatus("canceled")).toEqual({
      word: "stopped",
      bucket: "done",
      isLive: false,
    });
  });
});

describe("resolveSpawnCallStatus", () => {
  it("starts a Paseo spawn and works a provider one while the call runs", () => {
    expect(resolveSpawnCallStatus("running", "paseo").word).toBe("starting");
    expect(resolveSpawnCallStatus("executing", "provider").word).toBe("working");
  });
});

describe("summarizeSubagentStatuses", () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init();
    }
    await i18n.changeLanguage("en");
  });

  it("counts live states first and folds archived children into done", () => {
    const counts = summarizeSubagentStatuses([
      resolvePaseoSubagentStatus(paseo()),
      resolvePaseoSubagentStatus(paseo({ turn: OPEN_TURN })),
      resolvePaseoSubagentStatus(null),
      resolvePaseoSubagentStatus(paseo({ status: "initializing" })),
      resolveProviderSubagentStatus("failed"),
    ]);
    expect(counts).toEqual([
      { bucket: "working", count: 2 },
      { bucket: "failed", count: 1 },
      { bucket: "done", count: 2 },
    ]);
    expect(counts.map((entry) => formatSubagentStatusCount(i18n.t, entry)).join(" · ")).toBe(
      "2 working · 1 failed · 2 done",
    );
  });

  it("names each status word", () => {
    expect(formatSubagentStatusWord(i18n.t, "needsInput")).toBe("Needs input");
    expect(formatSubagentStatusWord(i18n.t, "archived")).toBe("Archived");
  });
});
