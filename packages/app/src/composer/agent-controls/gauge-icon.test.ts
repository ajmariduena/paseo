import { describe, expect, it } from "vitest";
import { resolveCircleGaugeRender } from "./gauge-icon";

describe("resolveCircleGaugeRender", () => {
  it.each([
    { size: 20, strokeWidth: 2 },
    { size: 16, strokeWidth: 2 },
    { size: 14, strokeWidth: 2 },
  ])("draws the circle to the $size pt ring's diameter and stroke", (ring) => {
    const render = resolveCircleGaugeRender(ring, "top");
    expect(render.size).toBe(ring.size);
    expect(render.strokeWidth).toBe(ring.strokeWidth);
    expect(render.radius * 2 + render.strokeWidth).toBe(ring.size);
    expect(render.center).toBe(ring.size / 2);
  });

  it("keeps the needle inside the circle's inner edge on every tier", () => {
    const ring = { size: 20, strokeWidth: 2 };
    for (const tier of ["low", "mid", "high", "top"] as const) {
      const render = resolveCircleGaugeRender(ring, tier);
      const reach = Math.hypot(render.needle.x - render.center, render.needle.y - render.center);
      expect(reach + render.strokeWidth / 2).toBeLessThan(render.radius - render.strokeWidth / 2);
    }
  });

  it("sweeps the needle left to right as the tier rises", () => {
    const ring = { size: 20, strokeWidth: 2 };
    const xs = (["low", "mid", "high", "top"] as const).map(
      (tier) => resolveCircleGaugeRender(ring, tier).needle.x,
    );
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBeLessThan(ring.size / 2);
    expect(xs[3]).toBeGreaterThan(ring.size / 2);
  });
});
