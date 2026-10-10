import { useEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";

// Wispr Flow's shape: tallest left of center, tapering harder on the right.
const BAR_WEIGHTS = [0.4, 0.68, 0.9, 1, 0.97, 0.84, 0.7, 0.64, 0.55, 0.36];
const BARS = BAR_WEIGHTS.map((weight, index) => ({ id: `bar-${index}`, weight }));
const BAR_WIDTH = 3;
const BAR_GAP = 5;
const MIN_HEIGHT = BAR_WIDTH;
const MAX_HEIGHT = 30;
// Room noise under autoGainControl sits around here; below it the bars rest.
const NOISE_GATE = 0.12;

interface DictationWaveformProps {
  volume: number;
  isMuted?: boolean;
  color: string;
}

export function DictationWaveform({ volume, isMuted = false, color }: DictationWaveformProps) {
  const level = isMuted ? 0 : Math.max(0, (volume - NOISE_GATE) / (1 - NOISE_GATE));
  const containerStyle = useMemo(() => [styles.container, isMuted && styles.muted], [isMuted]);

  return (
    <View style={containerStyle} testID="dictation-waveform">
      {BARS.map((bar) => (
        <WaveformBar key={bar.id} weight={bar.weight} level={level} color={color} />
      ))}
    </View>
  );
}

function WaveformBar({ weight, level, color }: { weight: number; level: number; color: string }) {
  const height = useSharedValue(MIN_HEIGHT);

  useEffect(() => {
    const jitter = level > 0 ? 0.7 + Math.random() * 0.6 : 1;
    const target = MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * Math.min(1, level * weight * jitter);
    height.value = withTiming(target, {
      duration: target > height.value ? 60 : 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [height, level, weight]);

  return <AnimatedBar height={height} color={color} />;
}

function AnimatedBar({ height, color }: { height: SharedValue<number>; color: string }) {
  const animatedStyle = useAnimatedStyle(() => ({ height: height.value }));
  const style = useMemo(
    () => [styles.bar, { backgroundColor: color }, animatedStyle],
    [color, animatedStyle],
  );
  return <Animated.View style={style} />;
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: BAR_GAP,
    height: MAX_HEIGHT,
  },
  muted: {
    opacity: 0.5,
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: BAR_WIDTH / 2,
  },
});
