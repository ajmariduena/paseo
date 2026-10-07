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
  resolveQuickPromptFeedbackWidth,
  type ComposerControlDensity,
  type QuickPromptPresentation,
} from "@/composer/agent-controls/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  useComposerLayoutMode,
  useQuickPromptCapacity,
  usePublishQuickPromptDensity,
} from "./capacity";
import { QuickPromptFeedback } from "./feedback";
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
 * The lean tablet row's one bookmark: with a default prompt a tap sends it and a long press opens
 * the picker; without one a tap opens the picker. A bare glyph like the mic beside it; green
 * says a tap will send.
 */
function LeanBookmarkTrigger({
  defaultPrompt,
  disabled,
  onSend,
}: {
  defaultPrompt: QuickPrompt | undefined;
  disabled: boolean;
  onSend: (prompt: QuickPrompt) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { hitSlop } = useComposerControlLayout();
  const ready = defaultPrompt !== undefined;
  const send = useCallback(() => {
    if (defaultPrompt) onSend(defaultPrompt);
  }, [defaultPrompt, onSend]);
  const triggerStyle = useMemo(() => [styles.trigger, styles.leanTrigger], []);
  const label = defaultPrompt
    ? t("quickPrompts.sendNamed", { title: defaultPrompt.title })
    : t("quickPrompts.open");
  return (
    <MenuTrigger
      style={triggerStyle}
      hitSlop={hitSlop}
      disabled={disabled}
      activation={ready ? "longPress" : "press"}
      onPress={ready ? send : undefined}
      delayLongPress={LONG_PRESS_MS}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={ready ? t("quickPrompts.longPressOpens") : undefined}
      testID={ready ? "quick-prompt-default" : "quick-prompts-picker-trigger"}
    >
      <BookmarkGlyph ready={ready} />
    </MenuTrigger>
  );
}

/**
 * The toolbar's quick-prompt slot. It always owns the capacity decision, but only draws the split
 * or bookmark while the budget keeps a trigger; on the phone row the picker lives in the
 * attachment menu and the feedback above the input. Nothing is drawn before the row is measured,
 * so the first paint never shows a stage the row will not keep.
 */
export function QuickPromptToolbar({ picker }: { picker: QuickPromptPicker }) {
  const { t } = useTranslation();
  const { binding, state, defaultPrompt } = picker;
  const touch = useControlDensity() === "touch";
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const { presentation, feedbackWidth } = useQuickPromptPresentation(picker);
  const hasFeedback = state.status !== "idle";
  const setMenuOpen = useCallback(
    (next: boolean) => {
      if (next) {
        binding.controller.cancel();
        binding.controller.dismiss();
      }
      setOpen(next);
    },
    [binding.controller],
  );
  const openPicker = useCallback(() => setMenuOpen(true), [setMenuOpen]);
  if (!presentation || !presentation.showTrigger) return null;
  const showDefault = presentation.showDefaultLabel && defaultPrompt !== undefined;
  if (presentation.tapSendsDefault) {
    return (
      <View style={[styles.cluster, touch && styles.clusterTouch]} testID="quick-prompts-toolbar">
        <MenuRoot open={open} onOpenChange={setMenuOpen} compactMode="sheet">
          <TouchTarget slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
            <LeanBookmarkTrigger
              defaultPrompt={defaultPrompt}
              disabled={defaultPrompt ? isQuickPromptSendDisabled(picker, defaultPrompt) : false}
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
      <MenuRoot open={open} onOpenChange={setMenuOpen} compactMode="sheet">
        <TouchTarget slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
          <View
            style={[styles.split, !hasFeedback && (hovered || open) && styles.splitActive]}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          >
            {hasFeedback ? (
              <QuickPromptFeedback
                variant="toolbar"
                state={state}
                width={feedbackWidth}
                undoMs={picker.undoMs}
                undo={binding.controller.cancel}
                retry={picker.retry}
                dismiss={binding.controller.dismiss}
                sendNow={binding.controller.sendNow}
              />
            ) : (
              <>
                {showDefault ? (
                  <PromptPill
                    prompt={defaultPrompt}
                    disabled={isQuickPromptSendDisabled(picker, defaultPrompt)}
                    onActivate={picker.activate}
                    onOpen={openPicker}
                  />
                ) : null}
                <QuickPromptMenuTrigger labeled={showDefault} />
              </>
            )}
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
 * The capacity decision and what it publishes: the density the clusters follow, and the surface
 * key the deferred send watches. `null` until the row has a width, so nothing is drawn or
 * published from an unmeasured frame.
 */
function useQuickPromptPresentation(picker: QuickPromptPicker): {
  presentation: QuickPromptPresentation | null;
  feedbackWidth: number;
} {
  const { binding, state, defaultPrompt, supported, loaded } = picker;
  const compact = useIsCompactFormFactor();
  const lean = useComposerLayoutMode(compact) === "lean";
  const touch = useControlDensity() === "touch";
  const { controls, width, blocked } = useQuickPromptCapacity();
  const previousPresentation = useRef<QuickPromptPresentation | undefined>(undefined);
  const measured = width > 0;
  const presentation = measured
    ? resolveQuickPromptPresentation({
        current: previousPresentation.current,
        // Attachment, context meter, mic and primary action keep their own space.
        availableWidth: width - estimateComposerFixedWidth(touch),
        compact,
        lean,
        touch,
        defaultLabel: defaultPrompt?.title ?? null,
        controls,
      })
    : null;
  useLayoutEffect(() => {
    if (presentation) previousPresentation.current = presentation;
  });
  // The lean bookmark keeps its glyph while a send waits; the bar above the input is its feedback.
  const hostsFeedback =
    Boolean(presentation?.showTrigger) && !presentation?.tapSendsDefault && state.status !== "idle";
  const density = resolvePublishedDensity({ supported, hostsFeedback, presentation });
  usePublishQuickPromptDensity(density);
  const presentationKey = resolvePresentationKey({
    presentation,
    compact: compact || lean,
    touch,
    fontScale: controls.fontScale,
  });
  const ready = measured && supported && loaded && binding.available && !blocked;
  const { setSurface } = binding;
  useLayoutEffect(() => {
    setSurface(presentationKey, ready);
  }, [setSurface, presentationKey, ready]);
  useLayoutEffect(() => () => setSurface("hidden", false), [setSurface]);
  return {
    presentation: supported ? presentation : null,
    feedbackWidth: resolveQuickPromptFeedbackWidth(width, touch, controls),
  };
}

function resolvePublishedDensity(input: {
  supported: boolean;
  hostsFeedback: boolean;
  presentation: QuickPromptPresentation | null;
}): ComposerControlDensity | null {
  if (!input.supported || !input.presentation) return null;
  return input.hostsFeedback ? "tight" : input.presentation.density;
}

/** Changes to this key cancel a waiting send, so it names everything that moves the control. */
function resolvePresentationKey(input: {
  presentation: QuickPromptPresentation | null;
  compact: boolean;
  touch: boolean;
  fontScale: number;
}): string {
  const { presentation } = input;
  if (!presentation) return "unmeasured";
  return `${input.compact}:${input.touch}:${input.fontScale}:${presentation.density}:${presentation.showTrigger}:${presentation.showDefaultLabel}`;
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
        surface="toolbar"
        label={prompt.title}
        disabled={disabled}
        onPress={press}
        onLongPress={onOpen}
        delayLongPress={LONG_PRESS_MS}
        accessibilityLabel={label}
        testID={prompt.isDefault ? "quick-prompt-default" : `quick-prompt-pill-${prompt.id}`}
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
  // One chip for both targets: the title's own hover would otherwise stop short of the caret.
  splitActive: { backgroundColor: theme.colors.surface2 },
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
