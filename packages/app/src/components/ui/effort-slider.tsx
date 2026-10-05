import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, type AccessibilityActionEvent, type LayoutChangeEvent } from "react-native";
import * as Haptics from "expo-haptics";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { isNative } from "@/constants/platform";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import { useEffortSliderKeyboard } from "./effort-slider-keyboard";
import { EffortSliderTopFill } from "./effort-slider-top-fill";
import {
  clampEffortIndex,
  effortStopFromRatio,
  effortStopRatio,
  resolveEffortStopIndex,
  resolveEffortTier,
  stepEffortIndex,
} from "./effort-stops";

export const EFFORT_SLIDER_TRACK_HEIGHT = 32;
export const EFFORT_SLIDER_THUMB_SIZE = 28;
const THUMB_INSET = (EFFORT_SLIDER_TRACK_HEIGHT - EFFORT_SLIDER_THUMB_SIZE) / 2;
const THUMB_RADIUS = EFFORT_SLIDER_THUMB_SIZE / 2;
const STOP_DOT_SIZE = 4;
/** The arrival pulse: a glow swells on the thumb and fades, 0.9 s end to end. */
export const EFFORT_ARRIVAL_PULSE_MS = 900;
const ARRIVAL_RISE_MS = 300;
const HALO_SPREAD = 10;
const THUMB_SPRING = { damping: 22, stiffness: 320, mass: 0.8 } as const;

export interface EffortSliderStop {
  id: string;
  label: string;
  isDefault?: boolean;
}

interface EffortSliderProps {
  stops: readonly EffortSliderStop[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
}

function thumbCenterForRatio(ratio: number, trackWidth: number): number {
  "worklet";
  return THUMB_INSET + THUMB_RADIUS + ratio * Math.max(0, trackWidth - EFFORT_SLIDER_TRACK_HEIGHT);
}

function ratioForPointer(x: number, trackWidth: number): number {
  const travel = Math.max(1, trackWidth - EFFORT_SLIDER_TRACK_HEIGHT);
  return (x - THUMB_INSET - THUMB_RADIUS) / travel;
}

function hapticForStop(tier: ReturnType<typeof resolveEffortTier>) {
  if (!isNative) return;
  const feedback =
    tier === "top"
      ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
      : Haptics.selectionAsync();
  void feedback.catch(() => {});
}

export function EffortSlider({
  stops,
  value,
  onChange,
  disabled = false,
  accessibilityLabel,
  testID,
}: EffortSliderProps) {
  const count = stops.length;
  const index = resolveEffortStopIndex(stops, value);
  const tier = resolveEffortTier(index, count);
  const isTop = tier === "top";
  const reduceMotion = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const ratio = useSharedValue(effortStopRatio(index, count));
  const arrival = useSharedValue(0);
  const previousTierRef = useRef(tier);
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const target = effortStopRatio(index, count);
    ratio.value = reduceMotion ? target : withSpring(target, THUMB_SPRING);
  }, [count, index, ratio, reduceMotion]);

  useEffect(() => {
    const arrived = tier === "top" && previousTierRef.current !== "top";
    previousTierRef.current = tier;
    if (!arrived || reduceMotion) return;
    arrival.value = withSequence(
      withTiming(1, { duration: ARRIVAL_RISE_MS }),
      withTiming(0, { duration: EFFORT_ARRIVAL_PULSE_MS - ARRIVAL_RISE_MS }),
    );
  }, [arrival, reduceMotion, tier]);

  const selectIndex = useCallback(
    (nextIndex: number) => {
      const clamped = clampEffortIndex(nextIndex, count);
      if (clamped === indexRef.current) return;
      const stop = stops[clamped];
      if (!stop) return;
      indexRef.current = clamped;
      hapticForStop(resolveEffortTier(clamped, count));
      onChange(stop.id);
    },
    [count, onChange, stops],
  );

  const trackWidthRef = useRef(0);
  trackWidthRef.current = trackWidth;
  const selectFromPointer = useCallback(
    (x: number) => {
      if (trackWidthRef.current <= 0) return;
      selectIndex(effortStopFromRatio(ratioForPointer(x, trackWidthRef.current), count));
    },
    [count, selectIndex],
  );

  const step = useCallback(
    (delta: number) => selectIndex(stepEffortIndex(indexRef.current, delta, count)),
    [count, selectIndex],
  );

  useEffortSliderKeyboard({ enabled: !disabled && count > 1, onStep: step });

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .enabled(!disabled)
      .runOnJS(true)
      // Select only after horizontal intent wins; a vertical scroll never activates the pan.
      .activeOffsetX([-4, 4])
      .failOffsetY([-12, 12])
      .onStart((event) => selectFromPointer(event.x))
      .onUpdate((event) => selectFromPointer(event.x));
    const tap = Gesture.Tap()
      .enabled(!disabled)
      .runOnJS(true)
      .maxDistance(8)
      .onEnd((event, success) => {
        if (success) selectFromPointer(event.x);
      });
    return Gesture.Exclusive(pan, tap);
  }, [disabled, selectFromPointer]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = readMeasuredWidth(event);
    if (width !== null) setTrackWidth(width);
  }, []);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "increment") step(1);
      if (event.nativeEvent.actionName === "decrement") step(-1);
    },
    [step],
  );

  const fillStyle = useAnimatedStyle(() => ({
    width: thumbCenterForRatio(ratio.value, trackWidth) + THUMB_RADIUS,
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbCenterForRatio(ratio.value, trackWidth) - THUMB_RADIUS }],
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: arrival.value * 0.55,
    transform: [
      { translateX: thumbCenterForRatio(ratio.value, trackWidth) - THUMB_RADIUS - HALO_SPREAD },
      { scale: 0.8 + arrival.value * 0.3 },
    ],
  }));

  const stopDots = useMemo(() => {
    if (trackWidth <= 0) return [];
    return stops.map((stop, stopIndex) => ({
      key: stop.id,
      visible: stopIndex > index,
      left: thumbCenterForRatio(effortStopRatio(stopIndex, count), trackWidth) - STOP_DOT_SIZE / 2,
    }));
  }, [count, index, stops, trackWidth]);

  const selected = stops[index];
  const accessibilityValue = useMemo(
    () => ({ min: 0, max: Math.max(0, count - 1), now: index, text: selected?.label }),
    [count, index, selected?.label],
  );

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={[styles.track, disabled && styles.trackDisabled]}
        onLayout={handleLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={accessibilityValue}
        accessibilityActions={ACCESSIBILITY_ACTIONS}
        onAccessibilityAction={handleAccessibilityAction}
        testID={testID}
      >
        <Animated.View style={[styles.fill, isTop && styles.fillTop, fillStyle]}>
          {isTop ? (
            <EffortSliderTopFill
              width={trackWidth}
              height={EFFORT_SLIDER_TRACK_HEIGHT}
              reduceMotion={reduceMotion}
            />
          ) : null}
        </Animated.View>
        {stopDots.map((dot) =>
          dot.visible ? <View key={dot.key} style={[styles.stopDot, { left: dot.left }]} /> : null,
        )}
        <Animated.View style={[styles.halo, haloStyle]} pointerEvents="none" />
        <Animated.View
          style={[styles.thumb, thumbStyle]}
          pointerEvents="none"
          testID={testID ? `${testID}-thumb` : undefined}
        />
      </View>
    </GestureDetector>
  );
}

const ACCESSIBILITY_ACTIONS = [{ name: "increment" }, { name: "decrement" }] as const;

const styles = StyleSheet.create((theme) => ({
  track: {
    height: EFFORT_SLIDER_TRACK_HEIGHT,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
    justifyContent: "center",
  },
  trackDisabled: {
    opacity: theme.opacity[50],
  },
  fill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    overflow: "hidden",
  },
  fillTop: {
    backgroundColor: theme.colors.statusMerged,
  },
  stopDot: {
    position: "absolute",
    width: STOP_DOT_SIZE,
    height: STOP_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: theme.opacity[50],
  },
  halo: {
    position: "absolute",
    top: THUMB_INSET - HALO_SPREAD,
    left: 0,
    width: EFFORT_SLIDER_THUMB_SIZE + HALO_SPREAD * 2,
    height: EFFORT_SLIDER_THUMB_SIZE + HALO_SPREAD * 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.white,
  },
  thumb: {
    position: "absolute",
    top: THUMB_INSET,
    left: 0,
    width: EFFORT_SLIDER_THUMB_SIZE,
    height: EFFORT_SLIDER_THUMB_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.white,
    shadowColor: theme.colors.palette.black,
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
}));
