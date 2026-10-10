/** Shared choreography for the top stop's fill, so web CSS and native Reanimated draw the same thing. */

export const EFFORT_TOP_SHIMMER_DURATION_MS = 3200;
export const EFFORT_TOP_SHIMMER_WIDTH_RATIO = 0.45;
export const EFFORT_TOP_SHIMMER_PEAK_OPACITY = 0.28;

export interface EffortTopParticle {
  id: string;
  /** Start position as a fraction of the fill's width and height. */
  x: number;
  y: number;
  /** Horizontal drift over one cycle, as a fraction of the fill's width. */
  driftX: number;
  /** Vertical lift at mid-cycle, in points. */
  liftY: number;
  size: number;
  peakOpacity: number;
  durationMs: number;
  delayMs: number;
}

export const EFFORT_TOP_PARTICLES: readonly EffortTopParticle[] = [
  {
    id: "p1",
    x: 0.12,
    y: 0.62,
    driftX: 0.08,
    liftY: -5,
    size: 2,
    peakOpacity: 0.85,
    durationMs: 2600,
    delayMs: 0,
  },
  {
    id: "p2",
    x: 0.31,
    y: 0.3,
    driftX: 0.06,
    liftY: 4,
    size: 1.5,
    peakOpacity: 0.7,
    durationMs: 2200,
    delayMs: 400,
  },
  {
    id: "p3",
    x: 0.52,
    y: 0.7,
    driftX: 0.07,
    liftY: -6,
    size: 2.5,
    peakOpacity: 0.8,
    durationMs: 3000,
    delayMs: 900,
  },
  {
    id: "p4",
    x: 0.68,
    y: 0.38,
    driftX: 0.05,
    liftY: 3,
    size: 1.5,
    peakOpacity: 0.65,
    durationMs: 2400,
    delayMs: 1300,
  },
  {
    id: "p5",
    x: 0.84,
    y: 0.56,
    driftX: 0.04,
    liftY: -4,
    size: 2,
    peakOpacity: 0.75,
    durationMs: 2800,
    delayMs: 600,
  },
];

/** A particle's opacity and lift at `t` in [0, 1]: born dim, brightest mid-cycle, gone by the end. */
export function effortParticlePhase(t: number): number {
  "worklet";
  return Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);
}
