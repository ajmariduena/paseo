import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

/**
 * A toolbar glyph's box. Glyphs are sized to the ring's ink height, which makes most boxes
 * fractional (22.5pt for a mic), and Yoga snaps a fractional frame to the pixel grid, up to half
 * a device pixel off on 2x screens. The box is rounded up to an even size so it centres on whole
 * pixels in the 28pt control, and the glyph is centred inside it with a transform, which Core
 * Animation applies unrounded.
 */
export function ComposerToolbarGlyph({
  children,
  size,
  inkOffsetY = 0,
}: {
  children: ReactNode;
  size: number;
  /** Extra downward shift in pt for a glyph whose rasterised ink sits off its box's centre. */
  inkOffsetY?: number;
}) {
  const box = Math.ceil(size / 2) * 2;
  const inset = (box - size) / 2;
  const frame = useMemo(() => ({ width: box, height: box }), [box]);
  const shift = useMemo(
    () => ({
      position: "absolute" as const,
      top: 0,
      left: 0,
      transform: [{ translateX: inset }, { translateY: inset + inkOffsetY }],
    }),
    [inset, inkOffsetY],
  );
  return (
    <View
      style={[styles.box, frame]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <View style={shift}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexShrink: 0,
  },
});
