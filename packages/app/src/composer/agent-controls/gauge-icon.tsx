import { useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { Gauge } from "lucide-react-native";
import type { AgentControlIconProps } from "@/agent-controls/icons";
import {
  resolveContextWindowMeterRing,
  type ContextWindowMeterRing,
} from "@/components/context-window-meter.utils";

// Lucide's gauge is an arc of radius 10 about (12,14) on the 24 grid, its ends at y=19. The
// toolbar draws it to the context ring beside it: the arc's outer width is the ring's diameter
// and its rendered stroke is the ring's stroke, so the glyph is scaled to fit the arc and the
// stroke is widened in grid units by the same factor instead of being scaled with it. The
// arc's ink spans y=4..19 plus the stroke, which puts its centre half a unit above the box
// centre on paper; rasterised, the round caps at the ends reach a quarter unit less than that on
// 2x and 3x screens, so the glyph is shifted down three quarters of a unit to measure centred on
// the row. The glyph's box is fractional
// (22.5pt for a 20pt ring) and Yoga snaps frames to the pixel grid, which moved the arc a device
// pixel on 2x screens, so the glyph lives in an even integer box at its origin and every
// fractional centring goes through a transform, which Core Animation applies unrounded.
const GAUGE_ARC_RADIUS = 10;
const GAUGE_GRID = 24;
const GAUGE_ARC_CENTER_OFFSET = 0.75;

export interface GaugeRender {
  /** The Lucide icon's box in pt. */
  size: number;
  /** In grid units; renders as the ring's stroke width. */
  strokeWidth: number;
  /** The even integer box the glyph is laid out in. */
  box: number;
  /** Translation in pt from the box's origin that centres the icon's box in it. */
  inset: number;
  /** Further downward shift in pt that centres the arc's ink on the box. */
  offsetY: number;
}

export function resolveGaugeRender(ring: ContextWindowMeterRing): GaugeRender {
  const unit = (ring.size - ring.strokeWidth) / (2 * GAUGE_ARC_RADIUS);
  const size = GAUGE_GRID * unit;
  const box = Math.ceil(size / 2) * 2;
  return {
    size,
    strokeWidth: ring.strokeWidth / unit,
    box,
    inset: (box - size) / 2,
    offsetY: GAUGE_ARC_CENTER_OFFSET * unit,
  };
}

interface GaugeIconProps extends AgentControlIconProps {
  /** The ring to match; without one the glyph size stands in for the ring's envelope. */
  ring?: ContextWindowMeterRing;
}

/** The gauge drawn to the context ring's width and stroke. */
export function GaugeIcon({ size, color, ring }: GaugeIconProps): ReactElement {
  const render = useMemo(
    () => resolveGaugeRender(ring ?? resolveContextWindowMeterRing(size)),
    [ring, size],
  );
  const frame = useMemo(() => ({ width: render.box, height: render.box }), [render.box]);
  const shift = useMemo(
    () => ({
      position: "absolute" as const,
      top: 0,
      left: 0,
      transform: [{ translateX: render.inset }, { translateY: render.inset + render.offsetY }],
    }),
    [render.inset, render.offsetY],
  );
  return (
    <View style={frame}>
      <View style={shift}>
        <Gauge size={render.size} strokeWidth={render.strokeWidth} color={color} />
      </View>
    </View>
  );
}
