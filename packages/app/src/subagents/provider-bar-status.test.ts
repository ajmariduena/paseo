import { describe, expect, it } from "vitest";
import {
  resolveProviderSubagentBarStatus,
  resolveProviderSubagentParentTarget,
} from "./provider-bar-status";

const TIMES = {
  createdAt: "2026-10-04T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:34.000Z",
};

describe("resolveProviderSubagentBarStatus", () => {
  it("starts before the descriptor arrives", () => {
    expect(resolveProviderSubagentBarStatus(null)).toEqual({ kind: "starting" });
  });

  it("ticks from creation while the subagent runs", () => {
    expect(resolveProviderSubagentBarStatus({ status: "running", ...TIMES })).toEqual({
      kind: "working",
      since: new Date(TIMES.createdAt),
    });
  });

  it("freezes at the last update once it completes", () => {
    expect(resolveProviderSubagentBarStatus({ status: "completed", ...TIMES })).toEqual({
      kind: "completed",
      durationMs: 34_000,
    });
  });

  it("reports failure and cancellation without a duration", () => {
    expect(resolveProviderSubagentBarStatus({ status: "failed", ...TIMES })).toEqual({
      kind: "failed",
    });
    expect(resolveProviderSubagentBarStatus({ status: "canceled", ...TIMES })).toEqual({
      kind: "stopped",
    });
  });
});

describe("resolveProviderSubagentParentTarget", () => {
  it("opens the managed agent for a direct child", () => {
    expect(
      resolveProviderSubagentParentTarget({ parentAgentId: "agt_1", parentSubagentId: null }),
    ).toEqual({ kind: "agent", agentId: "agt_1" });
  });

  it("opens the provider subagent that started a nested child", () => {
    expect(
      resolveProviderSubagentParentTarget({ parentAgentId: "agt_1", parentSubagentId: "sub_1" }),
    ).toEqual({ kind: "provider_subagent", parentAgentId: "agt_1", subagentId: "sub_1" });
  });
});
