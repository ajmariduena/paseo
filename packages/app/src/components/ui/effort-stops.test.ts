import { describe, expect, it } from "vitest";
import {
  effortStopFromRatio,
  hasModelEffortControl,
  effortStopRatio,
  resolveEffortAfterModelSwitch,
  resolveEffortDefaultIndex,
  resolveEffortStopIndex,
  resolveEffortTier,
  stepEffortIndex,
} from "./effort-stops";

const CLAUDE_STOPS = [
  { id: "low" },
  { id: "medium", isDefault: true },
  { id: "high" },
  { id: "xhigh" },
  { id: "max" },
];

const PI_STOPS = [{ id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }];

describe("effort stops", () => {
  it("maps the selected option to its index and falls back to the default", () => {
    expect(resolveEffortStopIndex(CLAUDE_STOPS, "high")).toBe(2);
    expect(resolveEffortStopIndex(CLAUDE_STOPS, "unknown")).toBe(1);
    expect(resolveEffortStopIndex(CLAUDE_STOPS, null)).toBe(1);
    expect(resolveEffortDefaultIndex(PI_STOPS)).toBe(0);
  });

  it("splits the stops below the top into thirds and keeps the top as its own family", () => {
    expect(CLAUDE_STOPS.map((_, index) => resolveEffortTier(index, CLAUDE_STOPS.length))).toEqual([
      "low",
      "mid",
      "high",
      "high",
      "top",
    ]);
    expect(PI_STOPS.map((_, index) => resolveEffortTier(index, PI_STOPS.length))).toEqual([
      "low",
      "mid",
      "high",
      "top",
    ]);
    expect(resolveEffortTier(0, 2)).toBe("low");
    expect(resolveEffortTier(1, 2)).toBe("top");
    expect(resolveEffortTier(0, 1)).toBe("low");
  });

  it("snaps a track position to the nearest stop and back", () => {
    const count = CLAUDE_STOPS.length;
    expect(effortStopFromRatio(0, count)).toBe(0);
    expect(effortStopFromRatio(0.1, count)).toBe(0);
    expect(effortStopFromRatio(0.13, count)).toBe(1);
    expect(effortStopFromRatio(0.5, count)).toBe(2);
    expect(effortStopFromRatio(0.9, count)).toBe(4);
    expect(effortStopFromRatio(1.4, count)).toBe(4);
    expect(effortStopFromRatio(-0.2, count)).toBe(0);
    expect(effortStopRatio(2, count)).toBe(0.5);
    expect(effortStopRatio(4, count)).toBe(1);
    expect(effortStopRatio(0, 1)).toBe(0);
  });

  it("steps within the scale without leaving it", () => {
    expect(stepEffortIndex(1, 1, 5)).toBe(2);
    expect(stepEffortIndex(4, 1, 5)).toBe(4);
    expect(stepEffortIndex(0, -1, 5)).toBe(0);
  });

  it("keeps the effort across a model switch when the new model offers it", () => {
    expect(
      resolveEffortAfterModelSwitch({ thinkingOptions: PI_STOPS, currentThinkingOptionId: "high" }),
    ).toBe("high");
  });

  it("resets to the new model's default when the current effort is not offered", () => {
    expect(
      resolveEffortAfterModelSwitch({
        thinkingOptions: CLAUDE_STOPS,
        currentThinkingOptionId: "minimal",
      }),
    ).toBe("medium");
    expect(
      resolveEffortAfterModelSwitch({ thinkingOptions: PI_STOPS, currentThinkingOptionId: "max" }),
    ).toBe("minimal");
  });

  it("has no effort to apply when the model has no scale", () => {
    expect(
      resolveEffortAfterModelSwitch({ thinkingOptions: [], currentThinkingOptionId: "high" }),
    ).toBeNull();
    expect(
      resolveEffortAfterModelSwitch({ thinkingOptions: null, currentThinkingOptionId: "high" }),
    ).toBeNull();
  });
});

describe("effort card availability", () => {
  it.each([
    [{ canSelectModel: false, effortCount: 0, hasFast: true }, true],
    [{ canSelectModel: false, effortCount: 3, hasFast: false }, true],
    [{ canSelectModel: true, effortCount: 0, hasFast: false }, true],
    [{ canSelectModel: false, effortCount: 0, hasFast: false }, false],
  ] as const)("keeps effort and Fast reachable with %j", (input, expected) => {
    expect(hasModelEffortControl(input)).toBe(expected);
  });
});
