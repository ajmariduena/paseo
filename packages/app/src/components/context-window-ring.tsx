import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  resolveContextWindowMeterRing,
  resolveContextWindowTone,
  type ContextWindowTone,
} from "./context-window-meter.utils";

const COMPACT_SVG_SIZE = 12;
const COMPACT_RADIUS = 5;
const COMPACT_STROKE_WIDTH = 1.75;
export const METER_SLOT_SIZE = 28;

export interface MeterUsage {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  roundedPercentage: number;
  tone: ContextWindowTone;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function resolveMeterUsage(
  maxTokens: number | null,
  usedTokens: number | null,
): MeterUsage | null {
  if (maxTokens === null || usedTokens === null) return null;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return null;
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return null;
  const percentage = (usedTokens / maxTokens) * 100;
  const clampedPercentage = clampPercentage(percentage);
  return {
    usedTokens,
    maxTokens,
    percentage: clampedPercentage,
    roundedPercentage: Math.round(percentage),
    tone: resolveContextWindowTone(clampedPercentage),
  };
}

export function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function getProgressColor(tone: ContextWindowTone, theme: Theme): string {
  if (tone === "danger") {
    return theme.colors.statusDanger;
  }
  if (tone === "warning") {
    return theme.colors.statusWarning;
  }
  return theme.colors.foregroundMuted;
}

export function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      containerStyle: styles.containerWithLabel,
    };
  }
  const ring = resolveContextWindowMeterRing(glyphSize);
  return {
    svgSize: ring.size,
    radius: (ring.size - ring.strokeWidth) / 2,
    strokeWidth: ring.strokeWidth,
    containerStyle: styles.container,
  };
}

type MeterGeometry = ReturnType<typeof getMeterGeometry>;

export interface MeterRingProps {
  usage: MeterUsage | null;
  geometry: MeterGeometry;
  showPercentage: boolean;
  pending: boolean;
}

// Wrap the whole SVG: withUnistyles adds a div on web, which cannot sit inside an SVG.
const ContextWindowRing = withUnistyles(function ContextWindowRing({
  size,
  radius,
  strokeWidth,
  percentage,
  trackColor,
  progressColor,
}: {
  size: number;
  radius: number;
  strokeWidth: number;
  percentage: number | null;
  trackColor: string;
  progressColor: string;
}) {
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={trackColor}
        strokeWidth={strokeWidth}
      />
      {percentage !== null ? (
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={progressColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (clampPercentage(percentage) / 100) * circumference}
          // SVG strokes start at three o'clock; the ring reads clockwise from twelve.
          transform={`rotate(-90 ${center} ${center})`}
        />
      ) : null}
    </Svg>
  );
});

export function MeterRing({
  usage,
  geometry,
  showPercentage,
  pending,
}: MeterRingProps): ReactElement {
  const tone = usage?.tone ?? "normal";
  const meterColors = useCallback(
    (theme: Theme) => ({
      progressColor: getProgressColor(tone, theme),
      trackColor: theme.colors.surface3,
    }),
    [tone],
  );
  return (
    <>
      <ContextWindowRing
        size={geometry.svgSize}
        radius={geometry.radius}
        strokeWidth={geometry.strokeWidth}
        percentage={usage?.percentage ?? null}
        uniProps={meterColors}
      />
      {usage && (showPercentage || tone !== "normal") ? (
        <Text style={[styles.percentageLabel, tone !== "normal" && toneTextStyle(tone)]}>
          {`${usage.roundedPercentage}%`}
        </Text>
      ) : null}
      {!usage && pending && showPercentage ? <View style={styles.skeletonLabel} /> : null}
    </>
  );
}

function toneTextStyle(tone: ContextWindowTone) {
  return tone === "danger" ? styles.percentageLabelDanger : styles.percentageLabelWarning;
}

export type TriggerStyle = ReturnType<typeof resolveTriggerStyle>;

export function resolveTriggerStyle(
  geometry: MeterGeometry,
  usage: MeterUsage | null,
  showPercentage: boolean,
) {
  if (usage && !showPercentage && usage.tone !== "normal") {
    return [styles.container, styles.containerLabeled];
  }
  return geometry.containerStyle;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: METER_SLOT_SIZE,
    height: METER_SLOT_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  containerLabeled: {
    width: "auto",
    minWidth: METER_SLOT_SIZE,
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  containerWithLabel: {
    height: METER_SLOT_SIZE,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  percentageLabelWarning: {
    color: theme.colors.statusWarning,
  },
  percentageLabelDanger: {
    color: theme.colors.statusDanger,
  },
  skeletonLabel: {
    width: 22,
    height: theme.fontSize.base,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
}));
