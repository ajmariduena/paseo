import { describe, expect, it } from "vitest";
import { ConnectionQuality } from "./connection-quality";

describe("ConnectionQuality", () => {
  it("degrades after the host stays unreachable", () => {
    const quality = new ConnectionQuality(true, 0);
    quality.update(false, 1_000);

    expect(quality.shouldDegrade(2_000)).toBe(false);
    expect(quality.shouldDegrade(4_100)).toBe(true);
  });

  it("degrades on repeated short drops", () => {
    const quality = new ConnectionQuality(true, 0);
    quality.update(false, 1_000);
    quality.update(true, 1_500);
    expect(quality.shouldDegrade(2_000)).toBe(false);
    quality.update(false, 20_000);
    quality.update(true, 20_500);

    expect(quality.shouldDegrade(21_000)).toBe(true);
  });

  it("recovers only after a long stable stretch, longer after each relapse", () => {
    const quality = new ConnectionQuality(false, 0);
    quality.noteDegraded(0);
    quality.update(true, 10_000);
    expect(quality.shouldRecover(30_000)).toBe(false);
    expect(quality.shouldRecover(55_000)).toBe(true);

    quality.noteRecovered(55_000);
    quality.update(false, 60_000);
    quality.noteDegraded(63_000);
    quality.update(true, 70_000);

    expect(quality.recoverDelayMs).toBe(90_000);
    expect(quality.shouldRecover(130_000)).toBe(false);
    expect(quality.shouldRecover(160_000)).toBe(true);
  });
});
