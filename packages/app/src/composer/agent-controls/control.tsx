import {
  Children,
  forwardRef,
  isValidElement,
  useCallback,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { TOUCH_ROW_HEIGHT, CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { useControlDensity } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import type { AgentControlIcon } from "@/agent-controls/icons";
import {
  resolveComposerToolbarGlyphBox,
  resolveComposerToolbarGlyphStroke,
} from "@/composer/agent-controls/layout";

const SHIELD_INK_EXTENT = 19.45;
const SHIELD_INK_OFFSET_Y = 0.35;

export type AgentControlIconTint = "muted" | "accent" | "blue" | "green" | "yellow";

const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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
    const { ring, hitSlop } = useComposerControlLayout();
    const isTouch = useControlDensity() === "touch";
    const isSheet = surface === "sheet";
    // The shield family spans 19.7 of the 24 grid on paper; rasterised, its pointed bottom lands
    // short and its apex full, so it measures 19.45 tall and a third of a point high. The toolbar
    // draws it to that span and nudges it down to sit on the ring's edges.
    const resolvedGlyphSize = isSheet
      ? ICON_SIZE.md
      : resolveComposerToolbarGlyphBox(ring, SHIELD_INK_EXTENT);
    const resolvedIconColor = iconColor ?? resolveTintColor(iconTint);
    const showValue = isSheet || showToolbarLabel;
    const triggerStyle = useCallback(
      ({ pressed, hovered }: PressableStateCallbackType) => [
        isSheet ? styles.sheetRow : styles.toolbarControl,
        isSheet && isTouch && styles.sheetRowTouch,
        !isSheet && !showToolbarLabel && styles.toolbarIconOnly,
        hovered && (isSheet ? styles.sheetRowInteractive : styles.hovered),
        (pressed || open) && (isSheet ? styles.sheetRowInteractive : styles.pressed),
        disabled && styles.disabled,
      ],
      [disabled, isSheet, isTouch, open, showToolbarLabel],
    );
    // Sheet rows drill into a page, so their caret points the way (docs/design.md §12).
    const sheetChevron = useMemo(
      () => (
        <View style={styles.sheetChevron}>
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={chevronMapping} />
        </View>
      ),
      [],
    );
    const chevron = resolveChevron({ isSheet, showCaret, sheetChevron });

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
        chevron={chevron}
      >
        {isSheet ? (
          <View style={styles.sheetGlyph}>
            <Icon size={resolvedGlyphSize} color={resolvedIconColor} />
          </View>
        ) : (
          <ComposerToolbarGlyph size={resolvedGlyphSize} inkOffsetY={SHIELD_INK_OFFSET_Y}>
            <Icon
              size={resolvedGlyphSize}
              color={resolvedIconColor}
              {...resolveComposerToolbarGlyphStroke(ring)}
            />
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

function resolveChevron(input: {
  isSheet: boolean;
  showCaret: boolean;
  sheetChevron: ReactNode;
}): ReactNode | null {
  if (!input.showCaret) return null;
  return input.isSheet ? input.sheetChevron : undefined;
}

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
  // A flat row for a card (`AgentControlRowGroup`): the card draws the frame and the dividers.
  sheetRow: {
    minHeight: CONTROL_HEIGHTS.compact,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: "transparent",
  },
  sheetRowTouch: {
    minHeight: TOUCH_ROW_HEIGHT,
  },
  sheetRowInteractive: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  sheetGlyph: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetChevron: {
    flexShrink: 0,
  },
  sheetLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  sheetValue: {
    maxWidth: "55%",
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  group: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  groupDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
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

/** A card of sheet rows: one frame, a divider between rows, the same rails as a settings card. */
export function AgentControlRowGroup({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <View style={styles.group}>
      {rows.map((row, index) => (
        <View
          key={isValidElement(row) && row.key !== null ? row.key : index}
          style={index > 0 ? styles.groupDivider : null}
        >
          {row}
        </View>
      ))}
    </View>
  );
}
