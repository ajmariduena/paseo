import { forwardRef, useCallback, type ComponentProps } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import type { AgentControlIcon } from "@/agent-controls/icons";

export type AgentControlIconTint = "muted" | "accent" | "blue" | "green" | "yellow";

type AgentControlTriggerProps = Omit<
  ComponentProps<typeof ComboboxTrigger>,
  "accessibilityLabel" | "block" | "children" | "chevron" | "onPress" | "style"
> & {
  icon: AgentControlIcon;
  iconColor?: string;
  /** A theme-resolved glyph color; `iconColor` wins when a caller already holds a theme value. */
  iconTint?: AgentControlIconTint;
  surface: "toolbar" | "sheet";
  label: string;
  value?: string;
  showToolbarLabel?: boolean;
  showCaret?: boolean;
  open?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
};

export const AgentControlTrigger = forwardRef<View, AgentControlTriggerProps>(
  function AgentControlTrigger(
    {
      icon: Icon,
      iconColor,
      iconTint = "muted",
      surface,
      label,
      value,
      showToolbarLabel = true,
      showCaret = false,
      open = false,
      disabled = false,
      onPress,
      accessibilityLabel,
      testID,
      ...triggerProps
    },
    ref,
  ) {
    const { glyphSize, hitSlop } = useComposerControlLayout();
    const isSheet = surface === "sheet";
    const resolvedGlyphSize = isSheet ? 16 : glyphSize;
    const resolvedIconColor = iconColor ?? resolveTintColor(iconTint);
    const showValue = isSheet || showToolbarLabel;
    const triggerStyle = useCallback(
      ({ pressed, hovered }: PressableStateCallbackType) => [
        isSheet ? styles.sheetRow : styles.toolbarControl,
        !isSheet && !showToolbarLabel && styles.toolbarIconOnly,
        hovered && (isSheet ? styles.sheetRowInteractive : styles.hovered),
        (pressed || open) && (isSheet ? styles.sheetRowInteractive : styles.pressed),
        disabled && styles.disabled,
      ],
      [disabled, isSheet, open, showToolbarLabel],
    );

    return (
      <ComboboxTrigger
        {...triggerProps}
        ref={ref}
        collapsable={false}
        disabled={disabled}
        onPress={onPress}
        hitSlop={isSheet ? undefined : hitSlop}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        chevron={showCaret ? undefined : null}
      >
        {isSheet ? (
          <View style={styles.sheetGlyph}>
            <Icon size={resolvedGlyphSize} color={resolvedIconColor} />
          </View>
        ) : (
          <ComposerToolbarGlyph size={resolvedGlyphSize}>
            <Icon size={resolvedGlyphSize} color={resolvedIconColor} />
          </ComposerToolbarGlyph>
        )}
        {isSheet ? (
          <Text style={styles.sheetLabel} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        {showValue ? (
          <Text style={isSheet ? styles.sheetValue : styles.toolbarValue} numberOfLines={1}>
            {value ?? label}
          </Text>
        ) : null}
      </ComboboxTrigger>
    );
  },
);

function resolveTintColor(tint: AgentControlIconTint): string {
  switch (tint) {
    case "muted":
      return styles.iconColor.color;
    case "accent":
      return styles.iconAccent.color;
    case "blue":
      return styles.iconBlue.color;
    case "green":
      return styles.iconGreen.color;
    case "yellow":
      return styles.iconYellow.color;
    default:
      throw new Error("unreachable");
  }
}

const styles = StyleSheet.create((theme) => ({
  toolbarControl: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  toolbarIconOnly: {
    width: 28,
    flexShrink: 0,
    paddingHorizontal: 0,
    justifyContent: "center",
  },
  toolbarValue: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  sheetRow: {
    minHeight: 44,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: -theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: theme.colors.surface1,
  },
  sheetRowInteractive: {
    backgroundColor: theme.colors.surface2,
  },
  sheetGlyph: {
    width: 20,
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  sheetValue: {
    maxWidth: "45%",
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  hovered: {
    backgroundColor: theme.colors.surface2,
  },
  pressed: {
    backgroundColor: theme.colors.surface0,
  },
  disabled: {
    opacity: 0.5,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconAccent: {
    color: theme.colors.accentBright,
  },
  iconBlue: {
    color: theme.colors.palette.blue[400],
  },
  iconGreen: {
    color: theme.colors.palette.green[400],
  },
  iconYellow: {
    color: theme.colors.palette.yellow[400],
  },
}));
