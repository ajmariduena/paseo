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
  resolveQuickPromptPresentation,
  estimateComposerFixedWidth,
  estimateQuickPromptPillWidth,
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

function QuickPromptMenuTrigger({
  labeled,
  hiddenPins,
}: {
  labeled: boolean;
  hiddenPins: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { hitSlop } = useComposerControlLayout();
  const triggerStyle = useMemo(() => [styles.trigger, labeled ? styles.divider : null], [labeled]);
  return (
    <MenuTrigger
      style={triggerStyle}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={t("quickPrompts.open")}
      accessibilityHint={hiddenPins ? t("quickPrompts.hiddenPins") : undefined}
      testID="quick-prompts-picker-trigger"
    >
      {labeled ? <ThemedChevron size={ICON_SIZE.sm} uniProps={iconMapping} /> : <BookmarkGlyph />}
      {hiddenPins ? <View style={styles.dot} /> : null}
    </MenuTrigger>
  );
}

// Stroked at the ring's absolute width so it sits in the ring and gauge's weight, not the
// toolbar's thinner default.
function BookmarkGlyph({ ready = false }: { ready?: boolean }): ReactElement {
  const { glyphSize, ring } = useComposerControlLayout();
  return (
    <ThemedBookmark
      size={glyphSize}
      strokeWidth={ring.strokeWidth}
      absoluteStrokeWidth
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
  const { binding, state, defaultPrompt, pinned } = picker;
  const touch = useControlDensity() === "touch";
  const { controls } = useQuickPromptCapacity();
  const [open, setOpen] = useState(false);
  const { presentation, feedbackWidth } = useQuickPromptPresentation(picker);
  const hasFeedback = state.status !== "idle";
  const visiblePinCount = presentation?.visiblePinCount ?? 0;
  const hiddenPins = pinned.length > visiblePinCount;
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
      {pinned.slice(0, hasFeedback ? 0 : visiblePinCount).map((prompt) => (
        <TouchTarget key={prompt.id} slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
          <PromptPill
            prompt={prompt}
            fontScale={controls.fontScale}
            disabled={isQuickPromptSendDisabled(picker, prompt)}
            onActivate={picker.activate}
          />
        </TouchTarget>
      ))}
      <MenuRoot open={open} onOpenChange={setMenuOpen} compactMode="sheet">
        <TouchTarget slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
          <View style={styles.split}>
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
                    fontScale={controls.fontScale}
                    disabled={isQuickPromptSendDisabled(picker, defaultPrompt)}
                    onActivate={picker.activate}
                    onOpen={openPicker}
                  />
                ) : null}
                <QuickPromptMenuTrigger
                  labeled={presentation.showDefaultLabel}
                  hiddenPins={hiddenPins}
                />
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
  const { binding, state, defaultPrompt, pinned, supported, loaded } = picker;
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
        pinnedLabels: pinned.map((prompt) => prompt.title),
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
    pinned,
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
  pinned: readonly QuickPrompt[];
}): string {
  const { presentation } = input;
  if (!presentation) return "unmeasured";
  const pins = input.pinned
    .slice(0, presentation.visiblePinCount)
    .map((prompt) => prompt.id)
    .join(",");
  return `${input.compact}:${input.touch}:${input.fontScale}:${presentation.density}:${presentation.showTrigger}:${presentation.showDefaultLabel}:${pins}`;
}

/** A named prompt, drawn exactly like the mode control: glyph, label, 28pt tall. */
function PromptPill({
  prompt,
  fontScale,
  disabled,
  onActivate,
  onOpen,
}: {
  prompt: QuickPrompt;
  fontScale: number;
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
  // The budget is a ceiling: the pill takes its natural width and ellipsizes only past it.
  const boundsStyle = useMemo(
    () => ({ maxWidth: estimateQuickPromptPillWidth(prompt.title, fontScale) }),
    [fontScale, prompt.title],
  );
  return (
    <View style={[styles.pillBounds, boundsStyle]}>
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
  // The same box as the model pill, with a visible frame because it holds two targets.
  split: {
    height: COMPOSER_TOOLBAR_GEOMETRY.controlSize,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  pillBounds: { flexShrink: 1, minWidth: 0 },
  divider: { borderLeftWidth: theme.borderWidth[1], borderLeftColor: theme.colors.borderAccent },
  trigger: {
    width: COMPOSER_TOOLBAR_GEOMETRY.controlSize,
    height: COMPOSER_TOOLBAR_GEOMETRY.controlSize,
    alignItems: "center",
    justifyContent: "center",
  },
  leanTrigger: {
    borderRadius: theme.borderRadius.full,
  },
  // Inside the segment's rounded corner: at 4pt the dot lands on the 16pt arc and reads as
  // sitting on the border.
  dot: {
    position: "absolute",
    right: theme.spacing[1.5],
    top: theme.spacing[1.5],
    width: 4,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
