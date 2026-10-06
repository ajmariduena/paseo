import { describe, expect, it } from "vitest";
import { resolveGaugeRender } from "./gauge-icon";

// Lucide's gauge arc: radius 10 about (12,14) on the 24 grid.
function arcInk(ring: { size: number; strokeWidth: number }) {
  const render = resolveGaugeRender(ring);
  const unit = render.size / 24;
  const stroke = render.strokeWidth * unit;
  return { outerWidth: 20 * unit + stroke, stroke, box: render.size };
}

describe("resolveGaugeRender", () => {
  it.each([
    { size: 20, strokeWidth: 2 },
    { size: 16, strokeWidth: 2 },
    { size: 14, strokeWidth: 2 },
  ])("draws the arc to the $size pt ring's width and stroke", (ring) => {
    const ink = arcInk(ring);
    expect(ink.outerWidth).toBeCloseTo(ring.size, 6);
    expect(ink.stroke).toBeCloseTo(ring.strokeWidth, 6);
  });

  it("widens the stroke in grid units rather than scaling the glyph up to it", () => {
    const ring = { size: 20, strokeWidth: 2 };
    const render = resolveGaugeRender(ring);
    expect(render.strokeWidth).toBeGreaterThan(2);
    expect(render.size).toBeLessThan((ring.size * 24) / 20);
  });
});
