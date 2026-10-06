import { describe, expect, it } from "vitest";
import {
  GAUGE_TIER_COLOR,
  resolveEffortSelection,
  resolveIntelligenceOpeningPage,
} from "./effort-selection";

const STOPS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", isDefault: true },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

describe("effort selection", () => {
  it("tints the gauge from quiet through accent and warning to the top stop's purple", () => {
    expect(GAUGE_TIER_COLOR).toEqual({
      low: "foregroundMuted",
      mid: "accentBright",
      high: "statusWarning",
      top: "statusMerged",
    });
    expect(STOPS.map((stop) => resolveEffortSelection(STOPS, stop.id).tier)).toEqual([
      "low",
      "mid",
      "high",
      "top",
    ]);
  });

  it("names the selected stop and knows whether it is the default", () => {
    expect(resolveEffortSelection(STOPS, "high")).toMatchObject({
      hasEffort: true,
      index: 2,
      isTop: false,
      isDefault: false,
      selectedId: "high",
      selectedLabel: "High",
    });
    expect(resolveEffortSelection(STOPS, undefined)).toMatchObject({
      index: 1,
      isDefault: true,
      selectedLabel: "Medium",
    });
    expect(resolveEffortSelection(STOPS, "max")).toMatchObject({ isTop: true, tier: "top" });
  });

  it("treats one or no stops as managed by the model, so the gauge opens Advanced", () => {
    const single = resolveEffortSelection([{ id: "max", label: "Max", isDefault: true }], "max");
    expect(single).toMatchObject({
      hasEffort: false,
      tier: "low",
      isTop: false,
      selectedId: "max",
      selectedLabel: "Max",
    });
    expect(resolveEffortSelection([], undefined)).toMatchObject({
      hasEffort: false,
      selected: null,
      selectedId: "",
      selectedLabel: "",
    });
    expect(resolveIntelligenceOpeningPage(single.hasEffort)).toBe("advanced");
    expect(resolveIntelligenceOpeningPage(true)).toBe("quick");
  });
});
