import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMenuContext } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TouchTarget, useTouchHitSlop } from "@/components/ui/touch-target";
import type { CompactTiming } from "@/composer/compaction/model";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  formatTokenCount,
  resolveContextWindowMeterRing,
  resolveContextWindowTone,
  type ContextWindowTone,
} from "./context-window-meter.utils";

export {
  resolveContextWindowMeterGlyphSize,
  resolveContextWindowMeterRing,
  type ContextWindowMeterRing,
} from "./context-window-meter.utils";

export interface ContextWindowCompaction {
  timing: CompactTiming;
  /** Runs after the panel has closed; owns its own confirmation. */
  onCompact: () => void;
}

interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
  /** Turns the meter into a button that opens the context panel with a compact action. */
  compaction?: ContextWindowCompaction | null;
}

const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const COMPACT_STROKE_WIDTH = 1.75;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;
const METER_SLOT_SIZE = 28;
const PANEL_WIDTH = 300;

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function getMeterColors(
  tone: ContextWindowTone,
  theme: ReturnType<typeof useUnistyles>["theme"],
): { progress: string; track: string } {
  const track = theme.colors.surface3;
  if (tone === "danger") {
    return { progress: theme.colors.statusDanger, track };
  }
  if (tone === "warning") {
    return { progress: theme.colors.statusWarning, track };
  }
  return { progress: theme.colors.foregroundMuted, track };
}

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const ring = resolveContextWindowMeterRing(glyphSize);
  return {
    svgSize: ring.size,
    center: ring.size / 2,
    radius: (ring.size - ring.strokeWidth) / 2,
    strokeWidth: ring.strokeWidth,
    circumference: Math.PI * (ring.size - ring.strokeWidth),
    containerStyle: styles.container,
  };
}

type MeterGeometry = ReturnType<typeof getMeterGeometry>;

interface MeterUsage {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  roundedPercentage: number;
  tone: ContextWindowTone;
  colors: { progress: string; track: string };
  sessionCost: string | null;
}

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  totalCostUsd,
  showPercentage = false,
  pending = false,
  glyphSize,
  compaction = null,
}: ContextWindowMeterProps) {
  const { theme } = useUnistyles();
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const geometry = getMeterGeometry(showPercentage, glyphSize);
  const usage = useMemo<MeterUsage | null>(() => {
    if (percentage === null || maxTokens === null || usedTokens === null) return null;
    const clampedPercentage = clampPercentage(percentage);
    const tone = resolveContextWindowTone(clampedPercentage);
    return {
      usedTokens,
      maxTokens,
      percentage: clampedPercentage,
      roundedPercentage: Math.round(percentage),
      tone,
      colors: getMeterColors(tone, theme),
      sessionCost: typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null,
    };
  }, [maxTokens, percentage, theme, totalCostUsd, usedTokens]);

  // No usage yet: reserve the footprint with a track-only ring while a session is
  // active so the real ring fades in without shifting siblings. Render nothing when
  // no usage is expected.
  if (usage === null) {
    if (!pending) {
      return null;
    }
    return (
      <View style={geometry.containerStyle}>
        <Svg
          width={geometry.svgSize}
          height={geometry.svgSize}
          viewBox={`0 0 ${geometry.svgSize} ${geometry.svgSize}`}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Circle
            cx={geometry.center}
            cy={geometry.center}
            r={geometry.radius}
            fill="none"
            stroke={theme.colors.surface3}
            strokeWidth={geometry.strokeWidth}
          />
        </Svg>
        {showPercentage ? <View style={styles.skeletonLabel} /> : null}
      </View>
    );
  }

  if (compaction) {
    return (
      <CompactableMeter
        usage={usage}
        geometry={geometry}
        showPercentage={showPercentage}
        compaction={compaction}
      />
    );
  }
  return <TooltipMeter usage={usage} geometry={geometry} showPercentage={showPercentage} />;
}

function MeterRing({
  usage,
  geometry,
  showPercentage,
}: {
  usage: MeterUsage;
  geometry: MeterGeometry;
  showPercentage: boolean;
}): ReactElement {
  const { svgSize, center, radius, strokeWidth, circumference } = geometry;
  const dashOffset = circumference - (usage.percentage / 100) * circumference;
  const { colors } = usage;
  const showLabel = showPercentage || usage.tone !== "normal";
  return (
    <>
      <Svg
        width={svgSize}
        height={svgSize}
        viewBox={`0 0 ${svgSize} ${svgSize}`}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={colors.track}
          strokeWidth={strokeWidth}
        />
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={colors.progress}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          // SVG strokes start at three o'clock; the ring reads clockwise from twelve.
          transform={`rotate(-90 ${center} ${center})`}
        />
      </Svg>
      {showLabel ? (
        <Text
          style={[styles.percentageLabel, usage.tone !== "normal" && toneTextStyle(usage.tone)]}
        >
          {`${usage.roundedPercentage}%`}
        </Text>
      ) : null}
    </>
  );
}

function toneTextStyle(tone: ContextWindowTone) {
  return tone === "danger" ? styles.percentageLabelDanger : styles.percentageLabelWarning;
}

function resolveTriggerStyle(geometry: MeterGeometry, usage: MeterUsage, showPercentage: boolean) {
  if (!showPercentage && usage.tone !== "normal") {
    return [styles.container, styles.containerLabeled];
  }
  return geometry.containerStyle;
}

function TooltipMeter({
  usage,
  geometry,
  showPercentage,
}: {
  usage: MeterUsage;
  geometry: MeterGeometry;
  showPercentage: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={resolveTriggerStyle(geometry, usage, showPercentage)}
          testID="context-window-meter"
          accessibilityRole="image"
          accessibilityLabel={t("contextWindow.accessibility", {
            percentage: usage.roundedPercentage,
          })}
        >
          <MeterRing usage={usage} geometry={geometry} showPercentage={showPercentage} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} testID="context-window-meter-tooltip">
        <View style={styles.tooltipContent}>
          <Text style={styles.tooltipTitle}>{t("contextWindow.title")}</Text>
          <Text style={styles.tooltipText}>
            {t("contextWindow.used", { percentage: usage.roundedPercentage })}
          </Text>
          <Text style={styles.tooltipDetail}>
            {t("contextWindow.tokens", {
              used: formatTokenCount(usage.usedTokens),
              max: formatTokenCount(usage.maxTokens),
            })}
          </Text>
          {usage.sessionCost ? (
            <Text style={styles.tooltipDetail}>
              {t("contextWindow.sessionCost", { cost: usage.sessionCost })}
            </Text>
          ) : null}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

function CompactableMeter({
  usage,
  geometry,
  showPercentage,
  compaction,
}: {
  usage: MeterUsage;
  geometry: MeterGeometry;
  showPercentage: boolean;
  compaction: ContextWindowCompaction;
}): ReactElement {
  const { t } = useTranslation();
  const hitSlop = useTouchHitSlop(METER_SLOT_SIZE);
  const restStyle = resolveTriggerStyle(geometry, usage, showPercentage);
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      restStyle,
      (hovered || pressed || open) && styles.triggerHighlighted,
    ],
    [restStyle],
  );
  return (
    <DropdownMenu compactMode="sheet">
      <TouchTarget slotSize={METER_SLOT_SIZE}>
        <DropdownMenuTrigger
          style={triggerStyle}
          hitSlop={hitSlop}
          testID="context-window-meter"
          accessibilityRole="button"
          accessibilityLabel={t("contextWindow.panel.accessibility", {
            percentage: usage.roundedPercentage,
          })}
        >
          <MeterRing usage={usage} geometry={geometry} showPercentage={showPercentage} />
        </DropdownMenuTrigger>
      </TouchTarget>
      <DropdownMenuContent
        side="top"
        align="end"
        offset={8}
        width={PANEL_WIDTH}
        sheetTitle={t("contextWindow.panel.title")}
        testID="context-window-panel"
      >
        <ContextWindowPanel usage={usage} compaction={compaction} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextWindowPanel({
  usage,
  compaction,
}: {
  usage: MeterUsage;
  compaction: ContextWindowCompaction;
}): ReactElement {
  const { t } = useTranslation();
  const { presentation, selectItem } = useMenuContext("ContextWindowPanel");
  const { onCompact } = compaction;
  const handleCompactPress = useCallback(
    () => selectItem(onCompact, true),
    [onCompact, selectItem],
  );
  const fillStyle = [
    styles.barFill,
    barToneStyle(usage.tone),
    inlineUnistylesStyle({ width: `${usage.percentage}%` as const }),
  ];
  return (
    <View style={styles.panel}>
      {presentation === "popover" ? (
        <Text style={styles.panelTitle}>{t("contextWindow.panel.title")}</Text>
      ) : null}
      <View style={styles.barTrack}>
        <View style={fillStyle} />
      </View>
      <View style={styles.panelRows}>
        <View style={styles.panelRow}>
          <Text style={styles.panelLabel}>{t("contextWindow.panel.used")}</Text>
          <Text style={styles.panelValue}>
            {t("contextWindow.panel.usedValue", {
              used: formatTokenCount(usage.usedTokens),
              max: formatTokenCount(usage.maxTokens),
              percentage: usage.roundedPercentage,
            })}
          </Text>
        </View>
        {usage.sessionCost ? (
          <View style={styles.panelRow}>
            <Text style={styles.panelLabel}>{t("contextWindow.panel.sessionCost")}</Text>
            <Text style={styles.panelValue}>{usage.sessionCost}</Text>
          </View>
        ) : null}
      </View>
      <Button variant="default" onPress={handleCompactPress} testID="context-window-compact">
        {compaction.timing === "after-turn"
          ? t("contextWindow.compact.actionAfterTurn")
          : t("contextWindow.compact.action")}
      </Button>
      <Text style={styles.panelHint}>{t("contextWindow.panel.hint")}</Text>
    </View>
  );
}

function barToneStyle(tone: ContextWindowTone) {
  if (tone === "danger") return styles.barFillDanger;
  if (tone === "warning") return styles.barFillWarning;
  return styles.barFillNormal;
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
  triggerHighlighted: {
    backgroundColor: theme.colors.surface2,
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
  tooltipContent: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  panel: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  panelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  barTrack: {
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  barFillNormal: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  barFillWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  barFillDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
  panelRows: {
    gap: theme.spacing[1.5],
  },
  panelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  panelLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  panelValue: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
  panelHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
