import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Bookmark, ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { QuickPrompt } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { MenuRoot, MenuTrigger, MenuSurface } from "@/components/ui/menu";
import { useControlDensity, useIsCompactFormFactor } from "@/constants/layout";
import {
  resolveQuickPromptPresentation,
  estimateComposerFixedWidth,
  estimateQuickPromptPillWidth,
  resolveQuickPromptFeedbackWidth,
  type QuickPromptPresentation,
} from "@/composer/agent-controls/layout";
import type { Theme } from "@/styles/theme";
import { useQuickPromptCapacity, usePublishQuickPromptDensity } from "./capacity";
import { QuickPromptFeedback } from "./feedback";
import { QuickPromptPickerList, isQuickPromptSendDisabled, type QuickPromptPicker } from "./picker";

export type { QuickPromptToolbarBinding } from "./picker";

const ThemedBookmark = withUnistyles(Bookmark);
const ThemedChevron = withUnistyles(ChevronDown);
const iconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function QuickPromptToolbarSlot({ picker }: { picker: QuickPromptPicker | undefined }) {
  if (!picker) return null;
  return <QuickPromptToolbar picker={picker} />;
}

function QuickPromptMenuTrigger({
  touch,
  labeled,
  hiddenPins,
}: {
  touch: boolean;
  labeled: boolean;
  hiddenPins: boolean;
}) {
  const { t } = useTranslation();
  const triggerStyle = useMemo(
    () => [touch ? styles.touchTrigger : styles.trigger, labeled ? styles.divider : null],
    [touch, labeled],
  );
  return (
    <MenuTrigger
      style={triggerStyle}
      accessibilityRole="button"
      accessibilityLabel={t("quickPrompts.open")}
      accessibilityHint={hiddenPins ? t("quickPrompts.hiddenPins") : undefined}
      testID="quick-prompts-picker-trigger"
    >
      {labeled ? (
        <ThemedChevron size={16} uniProps={iconMapping} />
      ) : (
        <ThemedBookmark size={18} uniProps={iconMapping} />
      )}
      {hiddenPins ? <View style={styles.dot} /> : null}
    </MenuTrigger>
  );
}

/**
 * The toolbar's quick-prompt slot. It always owns the capacity decision, but only draws the split
 * or bookmark while the budget keeps a trigger; on the phone row the picker lives in the
 * attachment menu and the feedback above the input.
 */
export function QuickPromptToolbar({ picker }: { picker: QuickPromptPicker }) {
  const { t } = useTranslation();
  const { binding, state, defaultPrompt, pinned } = picker;
  const compact = useIsCompactFormFactor();
  const touch = useControlDensity() === "touch";
  const { controls, width, blocked } = useQuickPromptCapacity();
  const [open, setOpen] = useState(false);
  const { setSurface } = binding;
  const previousPresentation = useRef<QuickPromptPresentation | undefined>(undefined);
  const presentation = resolveQuickPromptPresentation({
    current: previousPresentation.current,
    // Attachment, context meter, mic and primary action keep their own space.
    availableWidth: width - estimateComposerFixedWidth(touch),
    compact,
    touch,
    defaultLabel: defaultPrompt?.title ?? null,
    pinnedLabels: pinned.map((prompt) => prompt.title),
    controls,
  });
  useLayoutEffect(() => {
    previousPresentation.current = presentation;
  });
  const hasFeedback = state.status !== "idle";
  const hostsFeedback = presentation.showTrigger && hasFeedback;
  const controlDensity = hostsFeedback ? "tight" : presentation.density;
  usePublishQuickPromptDensity(picker.supported ? controlDensity : null);
  const feedbackWidth = resolveQuickPromptFeedbackWidth(width, touch, controls);
  const presentationKey = `${compact}:${touch}:${controls.fontScale}:${presentation.density}:${presentation.showTrigger}:${presentation.showDefaultLabel}:${pinned
    .slice(0, presentation.visiblePinCount)
    .map((prompt) => prompt.id)
    .join(",")}`;
  const ready = picker.supported && picker.loaded && binding.available && !blocked;
  useLayoutEffect(() => {
    setSurface(presentationKey, ready);
  }, [setSurface, presentationKey, ready]);
  useLayoutEffect(() => () => setSurface("hidden", false), [setSurface]);
  const hiddenPins = pinned.length > presentation.visiblePinCount;
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
  const showDefault = presentation.showDefaultLabel && defaultPrompt !== undefined;
  if (!picker.supported || !presentation.showTrigger) return null;
  return (
    <View style={styles.owner} testID="quick-prompts-toolbar">
      <View style={[styles.cluster, touch && styles.clusterTouch]}>
        {pinned.slice(0, hasFeedback ? 0 : presentation.visiblePinCount).map((prompt) => (
          <PromptPill
            key={prompt.id}
            prompt={prompt}
            fontScale={controls.fontScale}
            touch={touch}
            disabled={isQuickPromptSendDisabled(picker, prompt)}
            onActivate={picker.activate}
          />
        ))}
        <MenuRoot open={open} onOpenChange={setMenuOpen} compactMode="sheet">
          <View style={styles.split}>
            {hasFeedback ? (
              <QuickPromptFeedback
                state={state}
                width={feedbackWidth}
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
                    touch={touch}
                    disabled={isQuickPromptSendDisabled(picker, defaultPrompt)}
                    onActivate={picker.activate}
                    onOpen={openPicker}
                  />
                ) : null}
                <QuickPromptMenuTrigger
                  touch={touch}
                  labeled={presentation.showDefaultLabel}
                  hiddenPins={hiddenPins}
                />
              </>
            )}
          </View>
          <MenuSurface side="top" align="end" width={380} sheetTitle={t("quickPrompts.section")}>
            <QuickPromptPickerList picker={picker} />
          </MenuSurface>
        </MenuRoot>
      </View>
    </View>
  );
}

function PromptPill({
  prompt,
  fontScale,
  touch,
  disabled,
  onActivate,
  onOpen,
}: {
  prompt: QuickPrompt;
  fontScale: number;
  touch: boolean;
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
    <Button
      variant="ghost"
      size="xs"
      style={[
        touch ? styles.touchMain : styles.main,
        { width: estimateQuickPromptPillWidth(prompt.title, fontScale) },
      ]}
      numberOfLines={1}
      textStyle={styles.pillText}
      disabled={disabled}
      leftIcon={Bookmark}
      onPress={press}
      onLongPress={onOpen}
      delayLongPress={500}
      accessibilityLabel={label}
      testID={prompt.isDefault ? "quick-prompt-default" : `quick-prompt-pill-${prompt.id}`}
    >
      {prompt.title}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  owner: { position: "relative", flexShrink: 0 },
  cluster: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  clusterTouch: { gap: 12 },
  split: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
  },
  main: { minWidth: 28 },
  pillText: { flexShrink: 1, minWidth: 0 },
  touchMain: { minHeight: 44, minWidth: 44 },
  divider: { borderLeftWidth: 1, borderLeftColor: theme.colors.borderAccent },
  trigger: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  touchTrigger: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  dot: {
    position: "absolute",
    right: 5,
    top: 5,
    width: 4,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
