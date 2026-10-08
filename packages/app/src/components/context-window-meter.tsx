import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useMenuContext } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TouchTarget, useTouchHitSlop } from "@/components/ui/touch-target";
import type { CompactTiming } from "@/composer/compaction/model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import { AgentUsage, useHostReportsUsage } from "@/usage";
import { ContextWindowDetails } from "./context-window-details";
import { ContextWindowSheet } from "./context-window-sheet";
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
  serverId: string;
  agentId: string;
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  /** Show a loading label beside the empty ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
  /** Turns the meter into a button that opens the context panel with a compact action. */
  compaction?: ContextWindowCompaction | null;
}

const COMPACT_SVG_SIZE = 12;
const COMPACT_RADIUS = 5;
const COMPACT_STROKE_WIDTH = 1.75;
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

function getProgressColor(tone: ContextWindowTone, theme: Theme): string {
  if (tone === "danger") {
    return theme.colors.statusDanger;
  }
  if (tone === "warning") {
    return theme.colors.statusWarning;
  }
  return theme.colors.foregroundMuted;
}

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
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

interface MeterRingProps {
  usage: MeterUsage | null;
  geometry: MeterGeometry;
  showPercentage: boolean;
  pending: boolean;
}

interface MeterUsage {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  roundedPercentage: number;
  tone: ContextWindowTone;
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

export function ContextWindowMeter({
  serverId,
  agentId,
  maxTokens,
  usedTokens,
  totalCostUsd,
  showPercentage = false,
  pending = false,
  glyphSize,
  compaction = null,
}: ContextWindowMeterProps) {
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const geometry = useMemo(
    () => getMeterGeometry(showPercentage, glyphSize),
    [showPercentage, glyphSize],
  );
  const usage = useMemo<MeterUsage | null>(() => {
    if (percentage === null || maxTokens === null || usedTokens === null) return null;
    const clampedPercentage = clampPercentage(percentage);
    return {
      usedTokens,
      maxTokens,
      percentage: clampedPercentage,
      roundedPercentage: Math.round(percentage),
      tone: resolveContextWindowTone(clampedPercentage),
    };
  }, [maxTokens, percentage, usedTokens]);
  const sessionCost = typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;
  const ring = useMemo<MeterRingProps>(
    () => ({ usage, geometry, showPercentage, pending }),
    [usage, geometry, showPercentage, pending],
  );
  const triggerStyle = resolveTriggerStyle(geometry, usage, showPercentage);

  if (usage && compaction) {
    return (
      <CompactableMeter
        serverId={serverId}
        agentId={agentId}
        usage={usage}
        sessionCost={sessionCost}
        triggerStyle={triggerStyle}
        ring={ring}
        compaction={compaction}
      />
    );
  }
  return (
    <DetailsMeter
      serverId={serverId}
      agentId={agentId}
      usage={usage}
      sessionCost={sessionCost}
      triggerStyle={triggerStyle}
      ring={ring}
    />
  );
}

function MeterRing({ usage, geometry, showPercentage, pending }: MeterRingProps): ReactElement {
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

type TriggerStyle = ReturnType<typeof resolveTriggerStyle>;

function resolveTriggerStyle(
  geometry: MeterGeometry,
  usage: MeterUsage | null,
  showPercentage: boolean,
) {
  if (usage && !showPercentage && usage.tone !== "normal") {
    return [styles.container, styles.containerLabeled];
  }
  return geometry.containerStyle;
}

function DetailsMeter({
  serverId,
  agentId,
  usage,
  sessionCost,
  triggerStyle,
  ring,
}: {
  serverId: string;
  agentId: string;
  usage: MeterUsage | null;
  sessionCost: string | null;
  triggerStyle: TriggerStyle;
  ring: MeterRingProps;
}): ReactElement {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  // Usage cards need a wider popover; without them it keeps the plain tooltip shape.
  const showsUsage = useHostReportsUsage(serverId);
  const popoverWidth = Math.min(PANEL_WIDTH, width - 24);
  // Compact screens open the details in a sheet, which can hold a pressable Refresh.
  const isCompact = useIsCompactFormFactor();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const openSheet = useCallback(() => setIsSheetOpen(true), []);
  const closeSheet = useCallback(() => setIsSheetOpen(false), []);
  const context = useMemo(
    () =>
      usage
        ? {
            percentage: usage.roundedPercentage,
            maxTokens: usage.maxTokens,
            usedTokens: usage.usedTokens,
          }
        : null,
    [usage],
  );
  const accessibilityLabel = context
    ? t("contextWindow.accessibility", { percentage: context.percentage })
    : t("contextWindow.accessibilityNoData");

  if (isCompact) {
    return (
      <>
        <Pressable
          style={triggerStyle}
          testID="context-window-meter"
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={openSheet}
        >
          <MeterRing {...ring} />
        </Pressable>
        <ContextWindowSheet open={isSheetOpen} onClose={closeSheet}>
          <ContextWindowDetails
            serverId={serverId}
            agentId={agentId}
            context={context}
            sessionCost={sessionCost}
            showTitle={false}
            refreshable
          />
        </ContextWindowSheet>
      </>
    );
  }

  const popoverStyle = showsUsage
    ? [styles.usagePopover, { width: popoverWidth }]
    : styles.plainPopover;

  // Native wide screens have no hover, so the details open in a tooltip on press. The tooltip
  // takes no presses, so its usage cards have no Refresh.
  if (isNative) {
    return (
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
        <TooltipTrigger asChild triggerRefProp="ref">
          <Pressable
            style={triggerStyle}
            testID="context-window-meter"
            accessibilityRole="image"
            accessibilityLabel={accessibilityLabel}
          >
            <MeterRing {...ring} />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          offset={8}
          maxWidth={showsUsage ? popoverWidth : undefined}
          style={popoverStyle}
          testID="context-window-meter-tooltip"
        >
          <ContextWindowDetails
            serverId={serverId}
            agentId={agentId}
            context={context}
            sessionCost={sessionCost}
            showTitle
            refreshable={false}
          />
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <HoverCard>
      <HoverCardTrigger focusable accessibilityLabel={accessibilityLabel}>
        <View
          style={triggerStyle}
          testID="context-window-meter"
          accessibilityRole="image"
          accessibilityLabel={accessibilityLabel}
        >
          <MeterRing {...ring} />
        </View>
      </HoverCardTrigger>
      <HoverCardContent
        placement="top"
        offset={8}
        role="dialog"
        accessibilityLabel={t("contextWindow.title")}
        testID="context-window-details"
        style={popoverStyle}
      >
        <ContextWindowDetails
          serverId={serverId}
          agentId={agentId}
          context={context}
          sessionCost={sessionCost}
          showTitle
          refreshable
        />
      </HoverCardContent>
    </HoverCard>
  );
}

function CompactableMeter({
  serverId,
  agentId,
  usage,
  sessionCost,
  triggerStyle: restStyle,
  ring,
  compaction,
}: {
  serverId: string;
  agentId: string;
  usage: MeterUsage;
  sessionCost: string | null;
  triggerStyle: TriggerStyle;
  ring: MeterRingProps;
  compaction: ContextWindowCompaction;
}): ReactElement {
  const { t } = useTranslation();
  const hitSlop = useTouchHitSlop(METER_SLOT_SIZE);
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
          <MeterRing {...ring} />
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
        <ContextWindowPanel
          serverId={serverId}
          agentId={agentId}
          usage={usage}
          sessionCost={sessionCost}
          compaction={compaction}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextWindowPanel({
  serverId,
  agentId,
  usage,
  sessionCost,
  compaction,
}: {
  serverId: string;
  agentId: string;
  usage: MeterUsage;
  sessionCost: string | null;
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
        {sessionCost ? (
          <View style={styles.panelRow}>
            <Text style={styles.panelLabel}>{t("contextWindow.panel.sessionCost")}</Text>
            <Text style={styles.panelValue}>{sessionCost}</Text>
          </View>
        ) : null}
      </View>
      <Button variant="default" onPress={handleCompactPress} testID="context-window-compact">
        {compaction.timing === "after-turn"
          ? t("contextWindow.compact.actionAfterTurn")
          : t("contextWindow.compact.action")}
      </Button>
      <Text style={styles.panelHint}>{t("contextWindow.panel.hint")}</Text>
      <AgentUsage serverId={serverId} agentId={agentId} refreshable />
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
  // Plain details use a small inset; account usage cards have their own content density.
  plainPopover: { paddingVertical: theme.spacing[1], paddingHorizontal: theme.spacing[2] },
  usagePopover: { padding: theme.spacing[3], gap: theme.spacing[3] },
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
