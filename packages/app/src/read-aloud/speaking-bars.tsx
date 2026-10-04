import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";

const BAR_DELAYS = [0, 180, 360];
const REST_SCALE = 0.45;

function Bar({ progress, height }: { progress: SharedValue<number>; height: number }) {
  const style = useAnimatedStyle(() => ({
    transform: [{ scaleY: REST_SCALE + (1 - REST_SCALE) * progress.value }],
  }));
  return <Animated.View style={[styles.bar, { height }, style]} />;
}

export function SpeakingBars({ height, active }: { height: number; active: boolean }) {
  const first = useSharedValue(0.5);
  const second = useSharedValue(0.5);
  const third = useSharedValue(0.5);

  useEffect(() => {
    const bars = [first, second, third];
    for (const [index, bar] of bars.entries()) {
      if (!active) {
        cancelAnimation(bar);
        bar.value = withTiming(0.2, { duration: 150 });
        continue;
      }
      bar.value = withDelay(
        BAR_DELAYS[index] ?? 0,
        withRepeat(withTiming(1, { duration: 420, easing: Easing.inOut(Easing.ease) }), -1, true),
      );
    }
    return () => {
      for (const bar of bars) cancelAnimation(bar);
    };
  }, [active, first, second, third]);

  return (
    <View style={[styles.container, { height }]}>
      <Bar progress={first} height={height} />
      <Bar progress={second} height={height} />
      <Bar progress={third} height={height} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  bar: {
    width: 2,
    borderRadius: 1,
    backgroundColor: theme.colors.accentBright,
  },
}));
