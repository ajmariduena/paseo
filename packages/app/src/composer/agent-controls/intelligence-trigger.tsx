import { forwardRef, useCallback, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Gauge } from "lucide-react-native";
import { ModelProviderGlyph } from "@/components/model-browser";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import type { EffortTier } from "@/components/ui/effort-stops";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { GAUGE_TIER_COLOR } from "@/composer/agent-controls/effort-selection";
import { resolveIntelligenceTriggerKind } from "@/composer/agent-controls/layout";
import type { Theme } from "@/styles/theme";

const ThemedGauge = withUnistyles(Gauge);
const gaugeTierMapping: Record<EffortTier, (theme: Theme) => { color: string }> = {
  low: (theme) => ({ color: theme.colors[GAUGE_TIER_COLOR.low] }),
  mid: (theme) => ({ color: theme.colors[GAUGE_TIER_COLOR.mid] }),
  high: (theme) => ({ color: theme.colors[GAUGE_TIER_COLOR.high] }),
  top: (theme) => ({ color: theme.colors[GAUGE_TIER_COLOR.top] }),
};

export interface IntelligenceTriggerProps {
  provider: string;
  serverId: string | null;
  modelLabel: string;
  /** Null when the model has no effort scale. */
  effortLabel: string | null;
  tier: EffortTier;
  isTop: boolean;
  isFast: boolean;
  open: boolean;
  /** Replaces the labels while the control is open on wide layouts. */
  openLabel: string | null;
  disabled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID: string;
}

/**
 * The toolbar's entry to model, effort and speed. With room it is the model · effort pill; once
 * the model label no longer fits it is the gauge, tinted by tier and dotted when Fast is on.
 */
export const IntelligenceTrigger = forwardRef<View, IntelligenceTriggerProps>(
  function IntelligenceTrigger(
    {
      provider,
      serverId,
      modelLabel,
      effortLabel,
      tier,
      isTop,
      isFast,
      open,
      openLabel,
      disabled,
      onPress,
      accessibilityLabel,
      testID,
    },
    ref,
  ) {
    const { hitSlop, presentation } = useComposerControlLayout();
    const kind = resolveIntelligenceTriggerKind(presentation);
    const triggerStyle = useCallback(
      ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
        styles.trigger,
        kind === "gauge" && styles.triggerGauge,
        isTop && !open && styles.triggerTop,
        Boolean(hovered) && styles.triggerHovered,
        (pressed || open) && styles.triggerPressed,
        disabled && styles.triggerDisabled,
      ],
      [disabled, isTop, kind, open],
    );

    return (
      <ComboboxTrigger
        ref={ref}
        collapsable={false}
        disabled={disabled}
        onPress={onPress}
        hitSlop={hitSlop}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        chevron={kind === "pill" && presentation.showCarets ? undefined : null}
      >
        {kind === "gauge" ? (
          <GaugeGlyph tier={tier} isFast={isFast} />
        ) : (
          <PillLabel
            provider={provider}
            serverId={serverId}
            modelLabel={modelLabel}
            effortLabel={effortLabel}
            isTop={isTop}
            openLabel={openLabel}
          />
        )}
      </ComboboxTrigger>
    );
  },
);

function GaugeGlyph({ tier, isFast }: { tier: EffortTier; isFast: boolean }): ReactElement {
  const { glyphSize } = useComposerControlLayout();
  return (
    <ComposerToolbarGlyph size={glyphSize}>
      <ThemedGauge size={glyphSize} style={styles.gauge} uniProps={gaugeTierMapping[tier]} />
      {isFast ? <View style={styles.fastDot} testID="agent-intelligence-fast-dot" /> : null}
    </ComposerToolbarGlyph>
  );
}

function PillLabel({
  provider,
  serverId,
  modelLabel,
  effortLabel,
  isTop,
  openLabel,
}: {
  provider: string;
  serverId: string | null;
  modelLabel: string;
  effortLabel: string | null;
  isTop: boolean;
  openLabel: string | null;
}): ReactElement {
  const { glyphSize, presentation } = useComposerControlLayout();
  const glyph =
    provider.trim().length > 0 ? (
      <ComposerToolbarGlyph size={glyphSize}>
        <ModelProviderGlyph provider={provider} serverId={serverId} size={glyphSize} />
      </ComposerToolbarGlyph>
    ) : null;

  if (openLabel !== null) {
    return (
      <>
        {glyph}
        <Text style={styles.triggerOpenText} numberOfLines={1}>
          {openLabel}
        </Text>
      </>
    );
  }

  return (
    <>
      {glyph}
      <Text style={styles.triggerModelText} numberOfLines={1} ellipsizeMode="tail">
        {modelLabel}
      </Text>
      {effortLabel !== null && presentation.showEffortSuffix ? (
        <Text
          style={[styles.triggerEffortText, isTop && styles.triggerEffortTopText]}
          numberOfLines={1}
          testID="agent-effort-suffix"
        >
          {effortLabel}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    backgroundColor: "transparent",
  },
  triggerGauge: {
    width: 28,
    flexShrink: 0,
    paddingHorizontal: 0,
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  triggerTop: {
    backgroundColor: theme.colors.statusMergedTint,
    borderColor: theme.colors.statusMergedTint,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerModelText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerEffortText: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerEffortTopText: {
    color: theme.colors.statusMerged,
  },
  triggerOpenText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  // Lucide's gauge is an arc whose ends stop at 19/24, so its mass sits 1.5 units above the
  // box centre; one point down puts the arc and needle on the row's centerline.
  gauge: {
    transform: [{ translateY: 1 }],
  },
  fastDot: {
    position: "absolute",
    top: -1,
    right: -2,
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.surface1,
    backgroundColor: theme.colors.accentBright,
  },
}));
