import type { ReactElement } from "react";
import { Gauge } from "lucide-react-native";
import type { AgentControlIconProps } from "@/agent-controls/icons";

// Lucide's gauge is an arc about (12,14) with its ends at y=19, so with the 2-unit stroke its
// ink spans rows 3..20 of the 24 box: 17 units tall against the mic's 22 (rows 1..23). Drawn
// as-is beside the mic it reads smaller, so it is scaled up to the mic's ink height. The path
// puts the ink half a unit above the box centre, but the rasterised arc apex is faint enough
// that on 2x and 3x screens the visible ink already measures centred; nudging it down by that
// half unit was measured as 1 device pixel low on both.
const GAUGE_INK_ROWS = 17;
const MIC_INK_ROWS = 22;

export function resolveGaugeRenderSize(glyphSize: number): number {
  return (glyphSize * MIC_INK_ROWS) / GAUGE_INK_ROWS;
}

/** The gauge at a glyph slot's size, its ink centred on the slot like the row's other glyphs. */
export function GaugeIcon({ size, color }: AgentControlIconProps): ReactElement {
  return <Gauge size={resolveGaugeRenderSize(size)} color={color} />;
}
