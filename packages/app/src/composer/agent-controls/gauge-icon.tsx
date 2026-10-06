import { useMemo, type ReactElement } from "react";
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
// path puts the ink's centre half a unit above the box centre, but the arc's apex rasterises
// faint enough that the visible ink measures centred on 2x and 3x screens; shifting it down by
// that half unit measured one device pixel low on both.
const GAUGE_ARC_RADIUS = 10;
const GAUGE_GRID = 24;

export interface GaugeRender {
  /** The Lucide icon's box in pt. */
  size: number;
  /** In grid units; renders as the ring's stroke width. */
  strokeWidth: number;
}

export function resolveGaugeRender(ring: ContextWindowMeterRing): GaugeRender {
  const unit = (ring.size - ring.strokeWidth) / (2 * GAUGE_ARC_RADIUS);
  return { size: GAUGE_GRID * unit, strokeWidth: ring.strokeWidth / unit };
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
  return <Gauge size={render.size} strokeWidth={render.strokeWidth} color={color} />;
}
