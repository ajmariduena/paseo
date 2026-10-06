export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

export type ContextWindowTone = "normal" | "warning" | "danger";

export const CONTEXT_WINDOW_WARNING_PERCENTAGE = 75;
const CONTEXT_WINDOW_DANGER_PERCENTAGE = 90;

export function resolveContextWindowTone(percentage: number): ContextWindowTone {
  if (percentage > CONTEXT_WINDOW_DANGER_PERCENTAGE) return "danger";
  if (percentage >= CONTEXT_WINDOW_WARNING_PERCENTAGE) return "warning";
  return "normal";
}

export interface ContextWindowMeterRing {
  /** Outer diameter of the ring in pt; the stroke sits inside it. */
  size: number;
  strokeWidth: number;
}

const METER_RING_DEFAULT_SIZE = 14;
const METER_RING_STROKE_WIDTH = 2;
const METER_RING_GLYPH_SIZE = { web: 16, native: 20 } as const;

/**
 * The toolbar ring's glyph envelope. It is the same on every row width: the ring sits in the
 * same 28pt control as the mic and shield beside it, which draw at this size on every device.
 */
export function resolveContextWindowMeterGlyphSize(platform: "web" | "native"): number {
  return METER_RING_GLYPH_SIZE[platform];
}

/** The ring the meter draws for a glyph envelope, so sibling glyphs can be drawn to match it. */
export function resolveContextWindowMeterRing(glyphSize?: number): ContextWindowMeterRing {
  return { size: glyphSize ?? METER_RING_DEFAULT_SIZE, strokeWidth: METER_RING_STROKE_WIDTH };
}
