import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useKeyboardShift } from "./context";
import { resolveKeyboardRise } from "./policy";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
  /** Space already under the view; it rises only by the part of the keyboard beyond it. */
  spaceBelow?: number;
}

export function KeyboardTranslateView({
  children,
  enabled = true,
  spaceBelow,
  style,
  ...props
}: KeyboardTranslateViewProps) {
  const { shift, bottomInset } = useKeyboardShift();
  const keyboardStyle = useAnimatedStyle(() => {
    if (!enabled) return { transform: [{ translateY: 0 }] };
    const rise =
      spaceBelow === undefined
        ? shift.value
        : resolveKeyboardRise({
            keyboardHeight: shift.value > 0 ? shift.value + bottomInset.value : 0,
            spaceBelow,
          });
    return { transform: [{ translateY: -rise }] };
  }, [enabled, spaceBelow]);

  return (
    <Animated.View style={[style, keyboardStyle]} {...props}>
      {children}
    </Animated.View>
  );
}
