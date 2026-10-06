import { useMemo, type ReactElement } from "react";
import { Gauge } from "lucide-react-native";
import type { AgentControlIconProps } from "@/agent-controls/icons";

// Lucide's gauge is an arc about (12,14) with its ends at y=19, so with the 2-unit stroke its
// ink spans rows 3..20 of the 24 box: 17 units tall against the mic's 22 (rows 1..23), and
// centred half a unit above the box centre. Drawn as-is beside the mic it reads smaller and
// high, so it is scaled up to the mic's ink height and shifted down by the half unit.
const GAUGE_INK_ROWS = 17;
const MIC_INK_ROWS = 22;
const GAUGE_INK_CENTER_OFFSET = 0.5 / 24;

export function resolveGaugeRenderSize(glyphSize: number): number {
  return (glyphSize * MIC_INK_ROWS) / GAUGE_INK_ROWS;
}

export function resolveGaugeInkOffset(glyphSize: number): number {
  return resolveGaugeRenderSize(glyphSize) * GAUGE_INK_CENTER_OFFSET;
}

/** The gauge at a glyph slot's size, its ink centred on the slot like the row's other glyphs. */
export function GaugeIcon({ size, color }: AgentControlIconProps): ReactElement {
  const style = useMemo(
    () => ({ transform: [{ translateY: resolveGaugeInkOffset(size) }] }),
    [size],
  );
  return <Gauge size={resolveGaugeRenderSize(size)} color={color} style={style} />;
}
