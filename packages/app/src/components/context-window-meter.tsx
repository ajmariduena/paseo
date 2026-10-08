import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { AgentUsage, useHostReportsUsage } from "@/usage";
import { CompactableMeter, type ContextWindowCompaction } from "./context-window-compact-meter";
import { ContextWindowDetails } from "./context-window-details";
import {
  formatSessionCost,
  getMeterGeometry,
  MeterRing,
  resolveMeterUsage,
  resolveTriggerStyle,
  type MeterRingProps,
  type MeterUsage,
  type TriggerStyle,
} from "./context-window-ring";
import { ContextWindowSheet } from "./context-window-sheet";

export type { ContextWindowCompaction } from "./context-window-compact-meter";
export {
  resolveContextWindowMeterGlyphSize,
  resolveContextWindowMeterRing,
  type ContextWindowMeterRing,
} from "./context-window-meter.utils";

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

const PANEL_WIDTH = 300;

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
  const geometry = useMemo(
    () => getMeterGeometry(showPercentage, glyphSize),
    [showPercentage, glyphSize],
  );
  const usage = useMemo(() => resolveMeterUsage(maxTokens, usedTokens), [maxTokens, usedTokens]);
  const sessionCost = typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;
  const ring = useMemo<MeterRingProps>(
    () => ({ usage, geometry, showPercentage, pending }),
    [usage, geometry, showPercentage, pending],
  );
  const triggerStyle = resolveTriggerStyle(geometry, usage, showPercentage);

  if (usage && compaction) {
    return (
      <CompactableMeter
        usage={usage}
        sessionCost={sessionCost}
        triggerStyle={triggerStyle}
        ring={ring}
        compaction={compaction}
      >
        <AgentUsage serverId={serverId} agentId={agentId} refreshable />
      </CompactableMeter>
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

const styles = StyleSheet.create((theme) => ({
  // Plain details use a small inset; account usage cards have their own content density.
  plainPopover: { paddingVertical: theme.spacing[1], paddingHorizontal: theme.spacing[2] },
  usagePopover: { padding: theme.spacing[3], gap: theme.spacing[3] },
}));
