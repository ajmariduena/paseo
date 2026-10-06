import { useMemo, type ReactElement } from "react";
import Svg, { Circle, Line } from "react-native-svg";
import type { AgentControlIconProps } from "@/agent-controls/icons";
import {
  resolveContextWindowMeterRing,
  type ContextWindowMeterRing,
} from "@/components/context-window-meter.utils";
import type { EffortTier } from "@/components/ui/effort-stops";

// The dial is drawn to the context ring beside it: the same SVG box, circle radius and stroke,
// so the two read as one pair. The needle sweeps from upper left to upper right across the tiers
// and stays clear of the circle's inner edge.
const NEEDLE_LENGTH_RATIO = 0.57;
const NEEDLE_ANGLE_DEGREES: Record<EffortTier, number> = { low: -60, mid: -20, high: 20, top: 60 };

export interface CircleGaugeRender {
  size: number;
  strokeWidth: number;
  center: number;
  radius: number;
  needle: { x: number; y: number };
}

export function resolveCircleGaugeRender(
  ring: ContextWindowMeterRing,
  tier: EffortTier,
): CircleGaugeRender {
  const center = ring.size / 2;
  const radius = (ring.size - ring.strokeWidth) / 2;
  const length = radius * NEEDLE_LENGTH_RATIO;
  const angle = (NEEDLE_ANGLE_DEGREES[tier] * Math.PI) / 180;
  return {
    size: ring.size,
    strokeWidth: ring.strokeWidth,
    center,
    radius,
    needle: { x: center + length * Math.sin(angle), y: center - length * Math.cos(angle) },
  };
}

interface GaugeIconProps extends AgentControlIconProps {
  /** The ring to match; without one the glyph size stands in for the ring's envelope. */
  ring?: ContextWindowMeterRing;
  tier?: EffortTier;
}

/** The effort dial: a circle of the context ring's exact geometry with a needle inside. */
export function GaugeIcon({ size, color, ring, tier = "high" }: GaugeIconProps): ReactElement {
  const render = useMemo(
    () => resolveCircleGaugeRender(ring ?? resolveContextWindowMeterRing(size), tier),
    [ring, size, tier],
  );
  return (
    <Svg width={render.size} height={render.size} viewBox={`0 0 ${render.size} ${render.size}`}>
      <Circle
        cx={render.center}
        cy={render.center}
        r={render.radius}
        stroke={color}
        strokeWidth={render.strokeWidth}
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
    </Svg>
  );
}
