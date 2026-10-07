import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight, Zap } from "lucide-react-native";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { EFFORT_ARRIVAL_PULSE_MS } from "@/components/ui/effort-slider";
import type { EffortTier } from "@/components/ui/effort-stops";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedZap = withUnistyles(Zap);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const fastOnMapping = (theme: Theme) => ({ color: theme.colors.accentBright });
const fastTopMapping = (theme: Theme) => ({ color: theme.colors.statusMerged });
const ARRIVAL_RISE_MS = 300;

export type IntelligenceLabelSize = "card" | "overlay";

function effortNameTierStyle(tier: EffortTier) {
  switch (tier) {
    case "low":
      return styles.effortNameLow;
    case "mid":
      return styles.effortNameMid;
    case "high":
      return styles.effortNameHigh;
    case "top":
      return styles.effortNameTop;
    default:
      throw new Error("unreachable");
  }
}

function labelRowStyle({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, Boolean(hovered) && styles.rowHovered, pressed && styles.rowPressed];
}

/**
 * One line: the model in the foreground, the level in the tier's color, a chevron into Advanced.
 * The level glows when the thumb lands on the top stop; Fast shows as a bolt before the model.
 */
export function IntelligenceLabel({
  modelLabel,
  effortLabel,
  tier,
  isFast,
  size,
  disabled,
  onPress,
  accessibilityLabel,
  testID,
}: {
  modelLabel: string;
  /** Null when the model has no effort scale. */
  effortLabel: string | null;
  tier: EffortTier;
  isFast: boolean;
  size: IntelligenceLabelSize;
  disabled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID: string;
}): ReactElement {
  const iconSize = size === "overlay" ? ICON_SIZE.lg : ICON_SIZE.sm;
  const chevron = useMemo(
    () => (
      <View style={styles.chevron}>
        <ThemedChevronRight size={iconSize} uniProps={mutedIconMapping} />
      </View>
    ),
    [iconSize],
  );
  const textStyle = size === "overlay" ? styles.overlayText : styles.cardText;
  return (
    <ComboboxTrigger
      disabled={disabled}
      onPress={onPress}
      style={labelRowStyle}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      chevron={chevron}
    >
      {isFast ? (
        <ThemedZap size={iconSize} uniProps={tier === "top" ? fastTopMapping : fastOnMapping} />
      ) : null}
      <Text style={[styles.modelText, textStyle]} numberOfLines={1}>
        {modelLabel}
      </Text>
      {effortLabel !== null ? (
        <EffortName label={effortLabel} tier={tier} textStyle={textStyle} />
      ) : null}
    </ComboboxTrigger>
  );
}

/** The level's name, tinted by tier, with a glow that swells when the thumb lands on the top stop. */
export function EffortName({
  label,
  tier,
  textStyle,
}: {
  label: string;
  tier: EffortTier;
  textStyle: object;
}) {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0);
  const previousTierRef = useRef(tier);

  useEffect(() => {
    const arrived = tier === "top" && previousTierRef.current !== "top";
    previousTierRef.current = tier;
    if (!arrived || reduceMotion) return;
    pulse.value = withSequence(
      withTiming(1, { duration: ARRIVAL_RISE_MS }),
      withTiming(0, { duration: EFFORT_ARRIVAL_PULSE_MS - ARRIVAL_RISE_MS }),
    );
  }, [pulse, reduceMotion, tier]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 0.06 }],
    textShadowRadius: pulse.value * 14,
  }));

  return (
    <Animated.Text
      style={[styles.effortName, effortNameTierStyle(tier), textStyle, pulseStyle]}
      numberOfLines={1}
      testID="agent-effort-name"
    >
      {label}
    </Animated.Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 44,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  rowHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  rowPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  modelText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  cardText: {
    fontSize: theme.fontSize.lg,
    lineHeight: theme.fontSize.lg * 1.4,
  },
  overlayText: {
    fontSize: theme.fontSize["2xl"],
    lineHeight: theme.fontSize["2xl"] * 1.4,
  },
  // The trigger row's own gap is 4pt; a word-space at this size needs the full step.
  effortName: {
    flexShrink: 0,
    marginLeft: theme.spacing[1],
    fontWeight: theme.fontWeight.normal,
    textShadowColor: theme.colors.statusMerged,
    textShadowOffset: { width: 0, height: 0 },
  },
  effortNameLow: {
    color: theme.colors.foregroundMuted,
  },
  effortNameMid: {
    color: theme.colors.accentBright,
  },
  effortNameHigh: {
    color: theme.colors.statusWarning,
  },
  effortNameTop: {
    color: theme.colors.statusMerged,
  },
  chevron: {
    flexShrink: 0,
  },
}));
