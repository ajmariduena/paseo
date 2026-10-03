import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TOUCH_TARGET_SIZE, touchTargetOutset } from "@/components/ui/control-geometry";
import { useControlDensity } from "@/constants/layout";

export function useTouchHitSlop(visualSize: number): number | undefined {
  const density = useControlDensity();
  return density === "touch" ? touchTargetOutset(visualSize) : undefined;
}

/**
 * iOS and Android hit-test a child only inside its parent's frame unless a descendant's layout
 * overflows it, so `hitSlop` alone stops at the edge of a 28pt row. This frame overflows the row by
 * its negative margins; the control inside still needs `useTouchHitSlop` to answer in it.
 */
export function TouchTarget({
  children,
  slotSize,
}: {
  children: ReactNode;
  slotSize: number;
}): ReactNode {
  const density = useControlDensity();
  const frameStyle = useMemo(
    () => [styles.frame, { marginVertical: -touchTargetOutset(slotSize) }],
    [slotSize],
  );
  if (density === "pointer") return children;
  return <View style={frameStyle}>{children}</View>;
}

const styles = StyleSheet.create({
  frame: {
    minWidth: TOUCH_TARGET_SIZE,
    height: TOUCH_TARGET_SIZE,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
