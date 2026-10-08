import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { Bookmark, ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { QuickPrompt } from "@getpaseo/protocol/messages";
import { MenuRoot, MenuTrigger, MenuSurface } from "@/components/ui/menu";
import { TouchTarget } from "@/components/ui/touch-target";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useAgentControlsLayout } from "@/composer/agent-controls/index";
import {
  ComposerControlLayoutProvider,
  useComposerControlLayout,
} from "@/composer/agent-controls/layout-context";
import { useControlDensity, useIsCompactFormFactor } from "@/constants/layout";
import {
  COMPOSER_TOOLBAR_GEOMETRY,
  resolveComposerToolbarGlyphBox,
  resolveComposerToolbarGlyphStroke,
  resolveQuickPromptPresentation,
  estimateComposerFixedWidth,
  type QuickPromptPresentation,
} from "@/composer/agent-controls/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  useComposerLayoutMode,
  useQuickPromptCapacity,
  usePublishQuickPromptDensity,
} from "./capacity";
import { QuickPromptPickerList, isQuickPromptSendDisabled, type QuickPromptPicker } from "./picker";

export type { QuickPromptToolbarBinding } from "./picker";

const ThemedChevron = withUnistyles(ChevronDown);
const iconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const readyIconMapping = (theme: Theme) => ({ color: theme.colors.accentBright });
const LONG_PRESS_MS = 500;

/** Keeps the slot on the same glyph size and hit slop as the clusters beside it. */
export function QuickPromptToolbarSlot({ picker }: { picker: QuickPromptPicker | undefined }) {
  const layout = useAgentControlsLayout();
  if (!picker) return null;
  const toolbar = <QuickPromptToolbar picker={picker} />;
  if (!layout) return toolbar;
  return <ComposerControlLayoutProvider value={layout}>{toolbar}</ComposerControlLayoutProvider>;
}

function QuickPromptMenuTrigger({ labeled }: { labeled: boolean }): ReactElement {
  const { t } = useTranslation();
  const { hitSlop } = useComposerControlLayout();
  return (
    <MenuTrigger
      style={labeled ? styles.caretTrigger : styles.trigger}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={t("quickPrompts.open")}
      testID="quick-prompts-picker-trigger"
    >
      {labeled ? <ThemedChevron size={ICON_SIZE.sm} uniProps={iconMapping} /> : <BookmarkGlyph />}
    </MenuTrigger>
  );
}

// The bookmark spans 18 of the 24 grid, so it is drawn larger than the mic to reach the ring's
// height.
const BOOKMARK_INK_EXTENT = 18;

function BookmarkGlyph({ ready = false }: { ready?: boolean }): ReactElement {
  const { ring } = useComposerControlLayout();
  return (
    <ThemedBookmark
      size={resolveComposerToolbarGlyphBox(ring, BOOKMARK_INK_EXTENT)}
      {...resolveComposerToolbarGlyphStroke(ring)}
      uniProps={ready ? readyIconMapping : iconMapping}
    />
  );
}
const ThemedBookmark = withUnistyles(Bookmark);

/**
 * The tablet and icon-only desktop row's one bookmark. Green means a tap activates the shortcut;
 * a long press opens the picker. Without an available shortcut, a tap opens the picker.
 */
function ShortcutBookmarkTrigger({
  shortcutPrompt,
  sendDisabled,
  onSend,
}: {
  shortcutPrompt: QuickPrompt | undefined;
  sendDisabled: boolean;
  onSend: (prompt: QuickPrompt) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { hitSlop } = useComposerControlLayout();
  const ready = shortcutPrompt !== undefined && !sendDisabled;
  const send = useCallback(() => {
    if (ready && shortcutPrompt) onSend(shortcutPrompt);
  }, [ready, shortcutPrompt, onSend]);
  const triggerStyle = useMemo(() => [styles.trigger, styles.leanTrigger], []);
  let label = t("quickPrompts.open");
  if (shortcutPrompt && ready) {
    const key =
      shortcutPrompt.mode === "insert" ? "quickPrompts.insertNamed" : "quickPrompts.sendNamed";
    label = t(key, { title: shortcutPrompt.title });
  }
  let testID = "quick-prompts-picker-trigger";
  if (shortcutPrompt && ready) {
    testID = shortcutPrompt.isDefault ? "quick-prompt-default" : "quick-prompt-shortcut";
  }
  return (
    <MenuTrigger
      style={triggerStyle}
      hitSlop={hitSlop}
      activation={ready ? "longPress" : "press"}
      onPress={ready ? send : undefined}
      delayLongPress={LONG_PRESS_MS}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={ready ? t("quickPrompts.longPressOpens") : undefined}
      testID={testID}
    >
      <BookmarkGlyph ready={ready} />
    </MenuTrigger>
  );
}

/**
 * The toolbar's quick-prompt slot. It always owns the capacity decision, but only draws the split
 * or bookmark while the budget keeps a trigger; on the phone row the picker lives in the
 * attachment menu. Nothing is drawn before the row is measured, so the first paint never shows a
 * stage the row will not keep.
 */
export function QuickPromptToolbar({ picker }: { picker: QuickPromptPicker }) {
  const { t } = useTranslation();
  const { shortcutPrompt } = picker;
  const touch = useControlDensity() === "touch";
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const presentation = useQuickPromptPresentation(picker);
  const openPicker = useCallback(() => setOpen(true), []);
  if (!presentation || !presentation.showTrigger) return null;
  const showShortcutLabel = presentation.showShortcutLabel && shortcutPrompt !== undefined;
  if (presentation.leanShortcut) {
    return (
      <View style={[styles.cluster, touch && styles.clusterTouch]} testID="quick-prompts-toolbar">
        <MenuRoot open={open} onOpenChange={setOpen} compactMode="sheet">
          <TouchTarget slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
            <ShortcutBookmarkTrigger
              shortcutPrompt={shortcutPrompt}
              sendDisabled={
                shortcutPrompt ? isQuickPromptSendDisabled(picker, shortcutPrompt) : false
              }
              onSend={picker.activate}
            />
          </TouchTarget>
          <MenuSurface side="top" align="end" width={380} sheetTitle={t("quickPrompts.section")}>
            <QuickPromptPickerList picker={picker} />
          </MenuSurface>
        </MenuRoot>
      </View>
    );
  }
  return (
    <View style={[styles.cluster, touch && styles.clusterTouch]} testID="quick-prompts-toolbar">
      <MenuRoot open={open} onOpenChange={setOpen} compactMode="sheet">
        <TouchTarget slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
          <View
            style={styles.hoverTarget}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          >
            <View
              style={[styles.split, hovered && styles.splitHovered, open && styles.splitActive]}
            >
              {showShortcutLabel ? (
                <PromptPill
                  prompt={shortcutPrompt}
                  disabled={isQuickPromptSendDisabled(picker, shortcutPrompt)}
                  onActivate={picker.activate}
                  onOpen={openPicker}
                />
              ) : null}
              {shortcutPrompt && !showShortcutLabel ? (
                <ShortcutBookmarkTrigger
                  shortcutPrompt={shortcutPrompt}
                  sendDisabled={isQuickPromptSendDisabled(picker, shortcutPrompt)}
                  onSend={picker.activate}
                />
              ) : (
                <QuickPromptMenuTrigger labeled={showShortcutLabel} />
              )}
            </View>
          </View>
        </TouchTarget>
        <MenuSurface side="top" align="end" width={380} sheetTitle={t("quickPrompts.section")}>
          <QuickPromptPickerList picker={picker} />
        </MenuSurface>
      </MenuRoot>
    </View>
  );
}

/**
 * The capacity decision and the density it publishes for the clusters. `null` until the row has
 * a width, so nothing is drawn or published from an unmeasured frame.
 */
function useQuickPromptPresentation(picker: QuickPromptPicker): QuickPromptPresentation | null {
  const { shortcutPrompt, supported } = picker;
  const compact = useIsCompactFormFactor();
  const lean = useComposerLayoutMode(compact) === "lean";
  const touch = useControlDensity() === "touch";
  const { controls, width } = useQuickPromptCapacity();
  const previousPresentation = useRef<QuickPromptPresentation | undefined>(undefined);
  const presentation =
    width > 0
      ? resolveQuickPromptPresentation({
          current: previousPresentation.current,
          // Attachment, context meter, mic and primary action keep their own space.
          availableWidth: width - estimateComposerFixedWidth(touch),
          compact,
          lean,
          touch,
          shortcutLabel: shortcutPrompt?.title ?? null,
          controls,
        })
      : null;
  useLayoutEffect(() => {
    if (presentation) previousPresentation.current = presentation;
  });
  usePublishQuickPromptDensity(supported && presentation ? presentation.density : null);
  return supported ? presentation : null;
}

/** A named prompt, drawn exactly like the mode control: glyph, label, 28pt tall. */
function PromptPill({
  prompt,
  disabled,
  onActivate,
  onOpen,
}: {
  prompt: QuickPrompt;
  disabled: boolean;
  onActivate: (prompt: QuickPrompt) => void;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onActivate(prompt), [onActivate, prompt]);
  const label =
    prompt.mode === "insert"
      ? t("quickPrompts.insertNamed", { title: prompt.title })
      : t("quickPrompts.sendNamed", { title: prompt.title });
  return (
    <View style={styles.pillBounds}>
      <AgentControlTrigger
        icon={Bookmark}
        iconTint="accent"
        surface="toolbar"
        label={prompt.title}
        disabled={disabled}
        onPress={press}
        onLongPress={onOpen}
        delayLongPress={LONG_PRESS_MS}
        accessibilityLabel={label}
        testID={prompt.isDefault ? "quick-prompt-default" : "quick-prompt-shortcut"}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  cluster: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  clusterTouch: { gap: COMPOSER_TOOLBAR_GEOMETRY.touchControlGap },
  split: {
    height: COMPOSER_TOOLBAR_GEOMETRY.controlSize,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius["2xl"],
  },
  hoverTarget: { position: "relative" },
  // The pill paints the same surface on its own hover, so the two layers read as one.
  splitHovered: { backgroundColor: theme.colors.surface2 },
  splitActive: { backgroundColor: theme.colors.interactionHighlight },
  pillBounds: { flexShrink: 0 },
  // Pulled into the pill's padding so the caret sits as close to the title as the model pill's.
  caretTrigger: {
    width: 16,
    height: COMPOSER_TOOLBAR_GEOMETRY.controlSize,
    marginLeft: -2,
    marginRight: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
  },
  trigger: {
    width: COMPOSER_TOOLBAR_GEOMETRY.controlSize,
    height: COMPOSER_TOOLBAR_GEOMETRY.controlSize,
    alignItems: "center",
    justifyContent: "center",
  },
  leanTrigger: {
    borderRadius: theme.borderRadius.full,
  },
}));
