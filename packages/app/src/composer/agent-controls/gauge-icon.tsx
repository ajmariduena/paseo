import { useMemo, type ReactElement } from "react";
import Svg, { G, Line, Path } from "react-native-svg";
import type { AgentControlIconProps } from "@/agent-controls/icons";
import {
  resolveContextWindowMeterRing,
  type ContextWindowMeterRing,
} from "@/components/context-window-meter.utils";
import type { EffortTier } from "@/components/ui/effort-stops";

// The dial is drawn to the context ring beside it: the same SVG box, radius and stroke, opened
// at the bottom into a 270 degree arc like Lucide's gauge. The needle sweeps from upper left to
// upper right across the tiers and stays clear of the arc's inner edge.
//
// `geometric` keeps the arc's circle on the ring's centre, so the two tops coincide; the row is
// read by its top edge, and `optical`, which centres the shorter open arc's ink box on the row,
// dropped the dial's top a device pixel or two below the ring's and the mic's.
export type GaugeCentering = "geometric" | "optical";
export const GAUGE_CENTERING: GaugeCentering = "geometric";
const ARC_SWEEP_DEGREES = 270;
// A short base at the circle's bottom edge: the row is read by its top and bottom edges, and
// without it the open arc's ink stopped short of the ring's bottom. Lucide's gauge base is 8 of
// its 20-unit width.
const BASE_HALF_LENGTH_RATIO = 0.4;
const NEEDLE_LENGTH_RATIO = 0.57;
const NEEDLE_ANGLE_DEGREES: Record<EffortTier, number> = { low: -60, mid: -20, high: 20, top: 60 };

export interface CircleGaugeRender {
  size: number;
  strokeWidth: number;
  center: number;
  radius: number;
  /** Arc ends, from the bottom-left end clockwise over the top to the bottom-right end. */
  arc: { start: { x: number; y: number }; end: { x: number; y: number }; path: string };
  /** The arc's ink extents before any shift. */
  ink: { top: number; bottom: number };
  /** Downward shift of the whole glyph. */
  offsetY: number;
  needle: { x: number; y: number };
  /** The base line's y, on the circle's bottom edge, and its half length. */
  base: { y: number; halfLength: number };
}

function pointFromTop(center: number, radius: number, degrees: number): { x: number; y: number } {
  const angle = (degrees * Math.PI) / 180;
  return { x: center + radius * Math.sin(angle), y: center - radius * Math.cos(angle) };
}

export function resolveCircleGaugeRender(
  ring: ContextWindowMeterRing,
  tier: EffortTier,
  centering: GaugeCentering = GAUGE_CENTERING,
): CircleGaugeRender {
  const center = ring.size / 2;
  const radius = (ring.size - ring.strokeWidth) / 2;
  const half = ARC_SWEEP_DEGREES / 2;
  const start = pointFromTop(center, radius, -half);
  const end = pointFromTop(center, radius, half);
  const path = `M ${start.x} ${start.y} A ${radius} ${radius} 0 1 1 ${end.x} ${end.y}`;
  const ink = { top: center - radius - ring.strokeWidth / 2, bottom: end.y + ring.strokeWidth / 2 };
  const offsetY = centering === "optical" ? center - (ink.top + ink.bottom) / 2 : 0;
  const length = radius * NEEDLE_LENGTH_RATIO;
  const needle = pointFromTop(center, length, NEEDLE_ANGLE_DEGREES[tier]);
  return {
    size: ring.size,
    strokeWidth: ring.strokeWidth,
    center,
    radius,
    arc: { start, end, path },
    ink,
    offsetY,
    needle,
    base: { y: center + radius, halfLength: radius * BASE_HALF_LENGTH_RATIO },
  };
}

interface GaugeIconProps extends AgentControlIconProps {
  /** The ring to match; without one the glyph size stands in for the ring's envelope. */
  ring?: ContextWindowMeterRing;
  tier?: EffortTier;
}

/** The effort dial: a 270 degree arc of the context ring's exact geometry with a needle inside. */
export function GaugeIcon({ size, color, ring, tier = "high" }: GaugeIconProps): ReactElement {
  const render = useMemo(
    () => resolveCircleGaugeRender(ring ?? resolveContextWindowMeterRing(size), tier),
    [ring, size, tier],
  );
  return (
    <Svg width={render.size} height={render.size} viewBox={`0 0 ${render.size} ${render.size}`}>
      <G transform={`translate(0 ${render.offsetY})`}>
        <Path
          d={render.arc.path}
          stroke={color}
          strokeWidth={render.strokeWidth}
          strokeLinecap="round"
          fill="none"
        />
        <Line
          x1={render.center}
          y1={render.center}
          x2={render.needle.x}
          y2={render.needle.y}
          stroke={color}
          strokeWidth={render.strokeWidth}
          strokeLinecap="round"
        />
        <Line
          x1={render.center - render.base.halfLength}
          y1={render.base.y}
          x2={render.center + render.base.halfLength}
          y2={render.base.y}
          stroke={color}
          strokeWidth={render.strokeWidth}
          strokeLinecap="round"
        />
      </G>
    </Svg>
  );
}
