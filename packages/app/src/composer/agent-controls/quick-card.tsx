import { useCallback, useEffect, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight, Zap } from "lucide-react-native";
import type { AgentFeatureToggle } from "@getpaseo/protocol/agent-types";
import { ModelProviderGlyph } from "@/components/model-browser";
import { EffortSlider } from "@/components/ui/effort-slider";
import type { EffortOption, EffortSelection } from "@/composer/agent-controls/effort-selection";
import { EffortName } from "@/composer/agent-controls/intelligence-label";
import { formatContextWindow } from "@/composer/agent-controls/quick-card-format";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedZap = withUnistyles(Zap);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const fastOnMapping = (theme: Theme) => ({ color: theme.colors.accentBright });
const HIGHLIGHT_RISE_MS = 120;
const HIGHLIGHT_FADE_MS = 700;

function chipStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.chip, (Boolean(hovered) || pressed) && styles.chipHovered];
}

function fastChipStyle(on: boolean) {
  return ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
    styles.chip,
    on && styles.chipOn,
    (Boolean(hovered) || pressed) && styles.chipHovered,
  ];
}

/**
 * Speed and context at one tap, then the way into Advanced. Fast toggles; context is the model's
 * window and only informs, since a different window is a different model.
 */
export function QuickChips({
  fastFeature,
  isFast,
  onToggleFast,
  contextWindowMaxTokens,
  onOpenAdvanced,
  disabled,
}: {
  fastFeature: AgentFeatureToggle | null;
  isFast: boolean;
  onToggleFast: (() => void) | undefined;
  contextWindowMaxTokens: number | undefined;
  onOpenAdvanced: () => void;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const fastState = useMemo(() => ({ checked: isFast, disabled }), [disabled, isFast]);
  return (
    <View style={styles.chips}>
      {fastFeature && onToggleFast ? (
        <Pressable
          onPress={onToggleFast}
          disabled={disabled}
          style={fastChipStyle(isFast)}
          accessibilityRole="switch"
          accessibilityState={fastState}
          accessibilityLabel={fastFeature.label}
          testID="agent-quick-fast"
        >
          <ThemedZap size={ICON_SIZE.xs} uniProps={isFast ? fastOnMapping : mutedIconMapping} />
          <Text style={isFast ? styles.chipTextOn : styles.chipText}>
            {t("agentControls.quick.fast")}
          </Text>
        </Pressable>
      ) : null}
      {contextWindowMaxTokens ? (
        <View style={styles.chip} testID="agent-quick-context">
          <Text style={styles.chipText}>
            {t("agentControls.quick.context", {
              size: formatContextWindow(contextWindowMaxTokens),
            })}
          </Text>
        </View>
      ) : null}
      <View style={styles.spacer} />
      <Pressable
        onPress={onOpenAdvanced}
        disabled={disabled}
        style={chipStyle}
        accessibilityRole="button"
        accessibilityLabel={t("agentControls.advanced.open")}
        testID="agent-effort-advanced"
      >
        <Text style={styles.chipText}>{t("agentControls.advanced.title")}</Text>
        <ThemedChevronRight size={ICON_SIZE.xs} uniProps={mutedIconMapping} />
      </Pressable>
    </View>
  );
}

/** The model in use, with "Change" straight into the picker. Flashes after a switch. */
function QuickModelRow({
  provider,
  providerLabel,
  serverId,
  modelLabel,
  highlightToken,
  onChange,
  disabled,
}: {
  provider: string;
  providerLabel: string | null;
  serverId: string | null;
  modelLabel: string;
  highlightToken: number;
  onChange: (() => void) | undefined;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const highlight = useSharedValue(0);

  useEffect(() => {
    if (highlightToken === 0 || reduceMotion) return;
    highlight.value = withSequence(
      withTiming(1, { duration: HIGHLIGHT_RISE_MS }),
      withTiming(0, { duration: HIGHLIGHT_FADE_MS }),
    );
  }, [highlight, highlightToken, reduceMotion]);

  const highlightStyle = useAnimatedStyle(() => ({ opacity: highlight.value }));
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.modelRow,
      (Boolean(hovered) || pressed) && styles.modelRowHovered,
    ],
    [],
  );

  const content = (
    <>
      <Animated.View
        pointerEvents="none"
        style={[styles.modelRowHighlight, highlightStyle]}
        testID="agent-quick-model-highlight"
      />
      <ModelProviderGlyph
        provider={provider}
        serverId={serverId}
        size={ICON_SIZE.md}
        tone="foreground"
      />
      <View style={styles.modelText}>
        <Text style={styles.modelLabel} numberOfLines={1}>
          {modelLabel}
        </Text>
        {providerLabel ? (
          <Text style={styles.providerLabel} numberOfLines={1}>
            {providerLabel}
          </Text>
        ) : null}
      </View>
      {onChange ? (
        <View style={styles.change}>
          <Text style={styles.changeText}>{t("agentControls.quick.change")}</Text>
          <ThemedChevronRight size={ICON_SIZE.xs} uniProps={mutedIconMapping} />
        </View>
      ) : null}
    </>
  );

  if (!onChange) {
    return <View style={styles.modelRow}>{content}</View>;
  }
  return (
    <Pressable
      onPress={onChange}
      disabled={disabled}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={t("agentControls.quick.changeModel")}
      testID="agent-quick-change-model"
    >
      {content}
    </Pressable>
  );
}

export interface QuickCardProps {
  provider: string;
  providerLabel: string | null;
  serverId: string | null;
  modelLabel: string;
  highlightToken: number;
  onChangeModel: (() => void) | undefined;
  effort: EffortSelection;
  effortOptions: readonly EffortOption[];
  onSelectEffort: (id: string) => void;
  sliderDisabled: boolean;
  sliderLabel: string;
  fastFeature: AgentFeatureToggle | null;
  isFast: boolean;
  onToggleFast: (() => void) | undefined;
  contextWindowMaxTokens: number | undefined;
  onOpenAdvanced: () => void;
  disabled: boolean;
}

/** The popover's first page: model, the effort slider, then the one-tap chips. */
export function QuickCard(props: QuickCardProps): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.card} testID="agent-effort-card">
      <QuickModelRow
        provider={props.provider}
        providerLabel={props.providerLabel}
        serverId={props.serverId}
        modelLabel={props.modelLabel}
        highlightToken={props.highlightToken}
        onChange={props.onChangeModel}
        disabled={props.disabled}
      />
      <View style={styles.separator} />
      <View style={styles.effortHeading}>
        <Text style={styles.effortTitle}>{t("agentControls.effort.title")}</Text>
        {props.effort.hasEffort ? (
          <EffortName
            label={props.effort.selectedLabel}
            tier={props.effort.tier}
            textStyle={styles.effortValue}
          />
        ) : (
          <Text style={styles.effortManaged}>{t("agentControls.intelligence.managed")}</Text>
        )}
      </View>
      {props.effort.hasEffort ? (
        <EffortSlider
          stops={props.effortOptions}
          value={props.effort.selectedId}
          onChange={props.onSelectEffort}
          disabled={props.sliderDisabled}
          accessibilityLabel={props.sliderLabel}
          testID="agent-effort-slider"
        />
      ) : null}
      <QuickChips
        fastFeature={props.fastFeature}
        isFast={props.isFast}
        onToggleFast={props.onToggleFast}
        contextWindowMaxTokens={props.contextWindowMaxTokens}
        onOpenAdvanced={props.onOpenAdvanced}
        disabled={props.disabled}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  modelRow: {
    position: "relative",
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: -theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  modelRowHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  modelRowHighlight: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.surface3,
  },
  modelText: {
    flex: 1,
    minWidth: 0,
  },
  modelLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  providerLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  change: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
  },
  changeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  effortHeading: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingTop: theme.spacing[1],
  },
  effortTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  effortValue: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  effortManaged: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  chips: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingTop: theme.spacing[1],
  },
  chip: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipOn: {
    borderColor: theme.colors.accent,
  },
  chipHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  chipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  chipTextOn: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.accentBright,
  },
  spacer: {
    flex: 1,
  },
}));
