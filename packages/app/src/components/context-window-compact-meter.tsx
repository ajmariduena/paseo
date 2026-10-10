import { useCallback, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMenuContext } from "@/components/ui/menu";
import { TouchTarget, useTouchHitSlop } from "@/components/ui/touch-target";
import type { CompactTiming } from "@/composer/compaction/model";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { formatTokenCount, type ContextWindowTone } from "./context-window-meter.utils";
import {
  METER_SLOT_SIZE,
  MeterRing,
  type MeterRingProps,
  type MeterUsage,
  type TriggerStyle,
} from "./context-window-ring";

const PANEL_WIDTH = 300;

export interface ContextWindowCompaction {
  timing: CompactTiming;
  /** Runs after the panel has closed; owns its own confirmation. */
  onCompact: () => void;
}

/**
 * The meter as a button that opens the context panel with a compact action. It takes the
 * account usage as children so this module stays free of the usage data layer.
 */
export function CompactableMeter({
  usage,
  sessionCost,
  triggerStyle: restStyle,
  ring,
  compaction,
  children,
}: {
  usage: MeterUsage;
  sessionCost: string | null;
  triggerStyle: TriggerStyle;
  ring: MeterRingProps;
  compaction: ContextWindowCompaction;
  children?: ReactNode;
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
        <ContextWindowPanel usage={usage} sessionCost={sessionCost} compaction={compaction}>
          {children}
        </ContextWindowPanel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextWindowPanel({
  usage,
  sessionCost,
  compaction,
  children,
}: {
  usage: MeterUsage;
  sessionCost: string | null;
  compaction: ContextWindowCompaction;
  children?: ReactNode;
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
      {children}
    </View>
  );
}

function barToneStyle(tone: ContextWindowTone) {
  if (tone === "danger") return styles.barFillDanger;
  if (tone === "warning") return styles.barFillWarning;
  return styles.barFillNormal;
}

const styles = StyleSheet.create((theme) => ({
  triggerHighlighted: {
    backgroundColor: theme.colors.surface2,
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
