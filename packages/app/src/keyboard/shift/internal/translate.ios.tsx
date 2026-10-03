import { useMemo, type ReactNode } from "react";
import { Animated, type ViewProps } from "react-native";
import { useKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
  /** Space already under the view; it rises only by the part of the keyboard beyond it. */
  spaceBelow?: number;
}

// `height` runs from 0 down to minus the keyboard height.
const RISE_ONLY: Animated.InterpolationConfigType = {
  inputRange: [-100_000, 0],
  outputRange: [-100_000, 0],
  extrapolate: "clamp",
};

export function KeyboardTranslateView({
  children,
  enabled = true,
  spaceBelow,
  style,
  ...props
}: KeyboardTranslateViewProps) {
  const insets = useSafeAreaInsets();
  const { height, progress } = useKeyboardAnimation();
  const translateY = useMemo(
    () =>
      spaceBelow === undefined
        ? Animated.add(height, Animated.multiply(progress, insets.bottom))
        : Animated.add(height, spaceBelow).interpolate(RISE_ONLY),
    [height, insets.bottom, progress, spaceBelow],
  );
  const keyboardStyle = useMemo(
    () => ({ transform: [{ translateY: enabled ? translateY : 0 }] }),
    [enabled, translateY],
  );

  return (
    <Animated.View style={[style, keyboardStyle]} {...props}>
      {children}
    </Animated.View>
  );
}
