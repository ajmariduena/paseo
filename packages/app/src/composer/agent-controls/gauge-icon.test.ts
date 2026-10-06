import { describe, expect, it } from "vitest";
import { resolveCircleGaugeRender } from "./gauge-icon";

const RING = { size: 20, strokeWidth: 2 };

describe("resolveCircleGaugeRender", () => {
  it.each([
    { size: 20, strokeWidth: 2 },
    { size: 16, strokeWidth: 2 },
    { size: 14, strokeWidth: 2 },
  ])("draws the arc on the $size pt ring's circle and stroke", (ring) => {
    const render = resolveCircleGaugeRender(ring, "top");
    expect(render.size).toBe(ring.size);
    expect(render.strokeWidth).toBe(ring.strokeWidth);
    expect(render.radius * 2 + render.strokeWidth).toBe(ring.size);
    expect(render.center).toBe(ring.size / 2);
  });

  it("opens the circle at the bottom into a 270 degree arc", () => {
    const { arc, center, radius } = resolveCircleGaugeRender(RING, "top");
    const reach = radius * Math.SQRT1_2;
    expect(arc.start.x).toBeCloseTo(center - reach, 6);
    expect(arc.start.y).toBeCloseTo(center + reach, 6);
    expect(arc.end.x).toBeCloseTo(center + reach, 6);
    expect(arc.end.y).toBeCloseTo(center + reach, 6);
    expect(arc.path).toContain("A 9 9 0 1 1");
  });

  it("draws the base on the circle's bottom edge so the ink reaches the ring's bottom", () => {
    const render = resolveCircleGaugeRender(RING, "top", "geometric");
    expect(render.base.y + render.strokeWidth / 2).toBe(RING.size);
    expect(render.base.halfLength * 2).toBeLessThan(render.radius * 2);
  });

  it("keeps the arc's centre on the ring's centre when centred geometrically", () => {
    expect(resolveCircleGaugeRender(RING, "top", "geometric").offsetY).toBe(0);
  });

  it("centres the arc's ink box on the ring's centre when centred optically", () => {
    const render = resolveCircleGaugeRender(RING, "top", "optical");
    const inkCenter = (render.ink.top + render.ink.bottom) / 2 + render.offsetY;
    expect(inkCenter).toBeCloseTo(render.center, 6);
    expect(render.offsetY).toBeGreaterThan(0);
  });

  it("keeps the needle inside the arc's inner edge on every tier", () => {
    for (const tier of ["low", "mid", "high", "top"] as const) {
      const render = resolveCircleGaugeRender(RING, tier);
      const reach = Math.hypot(render.needle.x - render.center, render.needle.y - render.center);
      expect(reach + render.strokeWidth / 2).toBeLessThan(render.radius - render.strokeWidth / 2);
    }
  });

  it("sweeps the needle left to right as the tier rises", () => {
    const xs = (["low", "mid", "high", "top"] as const).map(
      (tier) => resolveCircleGaugeRender(RING, tier).needle.x,
    );
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBeLessThan(RING.size / 2);
    expect(xs[3]).toBeGreaterThan(RING.size / 2);
  });
});
