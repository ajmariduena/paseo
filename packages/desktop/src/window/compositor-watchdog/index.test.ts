import { describe, expect, it } from "vitest";

import { classifyFrameProbe, shouldRecoverFromFrameStall } from ".";

const MINUTE_MS = 60_000;

describe("compositor-watchdog", () => {
  describe("classifyFrameProbe", () => {
    it("counts a produced frame", () => {
      expect(
        classifyFrameProbe({ producedFrame: true, visibilityState: "visible", elapsedMs: 16 }),
      ).toBe("frame");
    });

    it("counts a missing frame as a stall when the deadline timer fired on time", () => {
      expect(
        classifyFrameProbe({ producedFrame: false, visibilityState: "visible", elapsedMs: 302 }),
      ).toBe("stall");
    });

    it("treats a late deadline timer as inconclusive because the renderer was busy", () => {
      expect(
        classifyFrameProbe({ producedFrame: false, visibilityState: "visible", elapsedMs: 1400 }),
      ).toBe("inconclusive");
    });

    it("treats a probe without timing as inconclusive", () => {
      expect(classifyFrameProbe({ producedFrame: false, visibilityState: "visible" })).toBe(
        "inconclusive",
      );
    });

    it("skips hidden documents and malformed results", () => {
      expect(
        classifyFrameProbe({ producedFrame: false, visibilityState: "hidden", elapsedMs: 300 }),
      ).toBe("skip");
      expect(classifyFrameProbe(null)).toBe("skip");
    });
  });

  describe("shouldRecoverFromFrameStall", () => {
    const now = 100 * MINUTE_MS;
    const recoverable = {
      stalledChecks: 3,
      recovering: false,
      now,
      recoveryTimestamps: [] as number[],
    };

    it("recovers once the stall threshold is reached", () => {
      expect(shouldRecoverFromFrameStall(recoverable)).toBe(true);
    });

    it("waits until the stall threshold is reached", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, stalledChecks: 2 })).toBe(false);
    });

    it("does not recover while a recovery is already in progress", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, recovering: true })).toBe(false);
    });

    it("respects the cooldown between recoveries", () => {
      expect(
        shouldRecoverFromFrameStall({ ...recoverable, recoveryTimestamps: [now - 30_000] }),
      ).toBe(false);
    });

    it("stops at two recoveries within thirty minutes so Chromium's GPU crash limit is never reached", () => {
      expect(
        shouldRecoverFromFrameStall({
          ...recoverable,
          recoveryTimestamps: [now - 20 * MINUTE_MS, now - 2 * MINUTE_MS],
        }),
      ).toBe(false);
    });

    it("allows another recovery once older ones leave the budget window", () => {
      expect(
        shouldRecoverFromFrameStall({
          ...recoverable,
          recoveryTimestamps: [now - 31 * MINUTE_MS, now - 2 * MINUTE_MS],
        }),
      ).toBe(true);
    });
  });
});
