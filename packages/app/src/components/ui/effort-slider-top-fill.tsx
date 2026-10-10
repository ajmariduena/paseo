import { useEffect } from "react";
import { StyleSheet as RNStyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { baseColors, type Theme } from "@/styles/theme";
import {
  EFFORT_TOP_PARTICLES,
  EFFORT_TOP_SHIMMER_DURATION_MS,
  EFFORT_TOP_SHIMMER_PEAK_OPACITY,
  EFFORT_TOP_SHIMMER_WIDTH_RATIO,
  effortParticlePhase,
  type EffortTopParticle,
} from "./effort-slider-top-fill-model";

interface EffortSliderTopFillProps {
  width: number;
  height: number;
  reduceMotion: boolean;
  gradientFrom: string;
  gradientTo: string;
}

function TopFill({
  width,
  height,
  reduceMotion,
  gradientFrom,
  gradientTo,
}: EffortSliderTopFillProps) {
  return (
    <View style={RNStyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="effortTopFill" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={gradientFrom} />
            <Stop offset="1" stopColor={gradientTo} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#effortTopFill)" />
      </Svg>
      {reduceMotion || width <= 0 ? null : (
        <>
          <Shimmer width={width} height={height} />
          {EFFORT_TOP_PARTICLES.map((particle) => (
            <Particle key={particle.id} particle={particle} width={width} height={height} />
          ))}
        </>
      )}
    </View>
  );
}

function Shimmer({ width, height }: { width: number; height: number }) {
  const bandWidth = width * EFFORT_TOP_SHIMMER_WIDTH_RATIO;
  const translateX = useSharedValue(-bandWidth);

  useEffect(() => {
    translateX.value = -bandWidth;
    translateX.value = withRepeat(
      withTiming(width, { duration: EFFORT_TOP_SHIMMER_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(translateX);
  }, [bandWidth, translateX, width]);

  const bandStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <Animated.View style={[styles.shimmerBand, { width: bandWidth, height }, bandStyle]}>
      <Svg width={bandWidth} height={height}>
        <Defs>
          <LinearGradient id="effortTopShimmer" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={baseColors.white} stopOpacity="0" />
            <Stop
              offset="0.5"
              stopColor={baseColors.white}
              stopOpacity={EFFORT_TOP_SHIMMER_PEAK_OPACITY}
            />
            <Stop offset="1" stopColor={baseColors.white} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={bandWidth} height={height} fill="url(#effortTopShimmer)" />
      </Svg>
    </Animated.View>
  );
}

function Particle({
  particle,
  width,
  height,
}: {
  particle: EffortTopParticle;
  width: number;
  height: number;
}) {
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = 0;
    t.value = withDelay(
      particle.delayMs,
      withRepeat(
        withTiming(1, { duration: particle.durationMs, easing: Easing.linear }),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(t);
  }, [particle.delayMs, particle.durationMs, t]);

  const particleStyle = useAnimatedStyle(() => {
    const phase = effortParticlePhase(t.value);
    return {
      opacity: phase * particle.peakOpacity,
      transform: [
        { translateX: particle.x * width + t.value * particle.driftX * width },
        { translateY: particle.y * height + phase * particle.liftY },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        styles.particle,
        { width: particle.size, height: particle.size, borderRadius: particle.size / 2 },
        particleStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  shimmerBand: {
    position: "absolute",
    top: 0,
    left: 0,
  },
  particle: {
    position: "absolute",
    top: 0,
    left: 0,
    backgroundColor: baseColors.white,
  },
});

export const EffortSliderTopFill = withUnistyles(TopFill, (theme: Theme) => ({
  gradientFrom: theme.colors.statusMerged,
  gradientTo: theme.colors.palette.purple[500],
}));
