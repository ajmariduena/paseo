import {
  useCallback,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Bookmark, ChevronDown, CornerDownLeft, Star, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { QuickPrompt } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import {
  MenuRoot,
  MenuTrigger,
  MenuSurface,
  MenuItem,
  MenuSeparator,
  useMenuContext,
} from "@/components/ui/menu";
import { useControlDensity, useIsCompactFormFactor } from "@/constants/layout";
import {
  resolveQuickPromptPresentation,
  estimateComposerFixedWidth,
  estimateQuickPromptPillWidth,
  resolveQuickPromptFeedbackWidth,
  type QuickPromptPresentation,
} from "@/composer/agent-controls/layout";
import type { Theme } from "@/styles/theme";
import type { DeferredQuickPromptSend, QuickPromptSendState } from "./deferred-send";
import { useQuickPrompts } from "./use-quick-prompts";
import { useQuickPromptCapacity, usePublishQuickPromptDensity } from "./capacity";
import {
  selectQuickPrompt,
  isQuickPromptActionDisabled,
  updateQuickPrompt,
  type QuickPromptPickerAction,
} from "./catalog";
import { newQuickPrompt } from "./form";
import { QuickPromptEditModal } from "./edit-modal";

export interface QuickPromptToolbarBinding {
  serverId: string;
  controller: DeferredQuickPromptSend;
  setSurface: (presentation: string, available: boolean) => void;
  insert: (text: string) => void;
  getDraft: () => string;
  available: boolean;
}

const ThemedBookmark = withUnistyles(Bookmark);
const ThemedChevron = withUnistyles(ChevronDown);
const iconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const feedbackKey = {
  started: "quickPrompts.sent",
  steered: "quickPrompts.steered",
  queued: "quickPrompts.queued",
} as const;
const actionKey = {
  send: "quickPrompts.send",
  steer: "quickPrompts.steer",
  queue: "quickPrompts.queue",
  interrupt: "quickPrompts.interrupt",
} as const;

export function QuickPromptToolbarSlot({
  binding,
}: {
  binding: QuickPromptToolbarBinding | undefined;
}) {
  if (!binding) return null;
  return <QuickPromptToolbar binding={binding} />;
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

function isQuickPromptReady(
  catalog: ReturnType<typeof useQuickPrompts>,
  available: boolean,
  blocked: boolean,
) {
  return catalog.supported && catalog.connected && catalog.loaded && available && !blocked;
}

export function QuickPromptToolbar({ binding }: { binding: QuickPromptToolbarBinding }) {
  const { t } = useTranslation();
  const catalog = useQuickPrompts(binding.serverId);
  const compact = useIsCompactFormFactor();
  const touch = useControlDensity() === "touch";
  const { controls, width, blocked } = useQuickPromptCapacity();
  const state = useSyncExternalStore(binding.controller.subscribe, binding.controller.getState);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QuickPrompt | null>(null);
  const [write, setWrite] = useState({ pending: false, error: "" });
  const writing = useRef(false);
  const { setSurface } = binding;
  const defaultPrompt = catalog.prompts.find((prompt) => prompt.isDefault);
  const pinned = catalog.prompts.filter(
    (prompt) => prompt.pinned && prompt.id !== defaultPrompt?.id,
  );
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
  const controlDensity = hasFeedback ? "tight" : presentation.density;
  usePublishQuickPromptDensity(catalog.supported ? controlDensity : null);
  const feedbackWidth = resolveQuickPromptFeedbackWidth(width, touch, controls);
  const presentationKey = `${compact}:${touch}:${controls.fontScale}:${presentation.density}:${presentation.showDefaultLabel}:${pinned
    .slice(0, presentation.visiblePinCount)
    .map((prompt) => prompt.id)
    .join(",")}`;
  const ready = isQuickPromptReady(catalog, binding.available, blocked);
  useLayoutEffect(() => {
    setSurface(presentationKey, ready);
  }, [setSurface, presentationKey, ready]);
  useLayoutEffect(() => () => setSurface("hidden", false), [setSurface]);
  const select = useCallback(
    (prompt: QuickPrompt, action: QuickPromptPickerAction) => {
      if (writing.current) return;
      writing.current = true;
      setWrite({ pending: true, error: "" });
      void selectQuickPrompt({
        prompt,
        action,
        prompts: catalog.prompts,
        ports: {
          send: (entry) => {
            if (ready) binding.controller.start(entry, catalog.undoMs);
            else binding.controller.unavailable();
          },
          insert: (text) => {
            binding.controller.cancel();
            binding.insert(text);
          },
          save: catalog.save,
        },
      })
        .then(
          () => setWrite({ pending: false, error: "" }),
          (error: unknown) =>
            setWrite({
              pending: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        .finally(() => {
          writing.current = false;
        });
    },
    [binding, catalog, ready],
  );
  const activate = useCallback((prompt: QuickPrompt) => select(prompt, prompt.mode), [select]);
  const prepareSelection = useCallback(
    (prompt: QuickPrompt, action: QuickPromptPickerAction) =>
      action === "send"
        ? binding.controller.guardSelection(() => select(prompt, action))
        : () => select(prompt, action),
    [binding.controller, select],
  );
  const sendDisabled = state.status === "sending" || write.pending;
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
  const add = useCallback(() => {
    binding.controller.cancel();
    setEditing(newQuickPrompt());
  }, [binding.controller]);
  const saveDraft = useCallback(() => {
    binding.controller.cancel();
    setEditing(newQuickPrompt(binding.getDraft()));
  }, [binding]);
  const close = useCallback(() => setEditing(null), []);
  const save = useCallback(
    (prompt: QuickPrompt) => catalog.save(updateQuickPrompt(catalog.prompts, prompt)),
    [catalog],
  );
  const retry = useCallback(
    () => binding.controller.retry(catalog.undoMs),
    [binding.controller, catalog.undoMs],
  );
  const pinCount = catalog.prompts.filter((prompt) => prompt.pinned).length;
  const showDefault = presentation.showDefaultLabel && defaultPrompt !== undefined;
  const rowDisabled = sendDisabled || write.pending;
  const editDisabled = !catalog.loaded || !catalog.connected;
  const draftDisabled = editDisabled || !binding.getDraft().trim();
  if (!catalog.supported) return null;
  return (
    <View style={styles.owner} testID="quick-prompts-toolbar">
      <View style={[styles.cluster, touch && styles.clusterTouch]}>
        {pinned.slice(0, hasFeedback ? 0 : presentation.visiblePinCount).map((prompt) => (
          <PromptPill
            key={prompt.id}
            prompt={prompt}
            fontScale={controls.fontScale}
            touch={touch}
            disabled={isQuickPromptActionDisabled(prompt.mode, write.pending, sendDisabled)}
            onActivate={activate}
          />
        ))}
        <MenuRoot open={open} onOpenChange={setMenuOpen} compactMode="sheet">
          <View style={styles.split}>
            {hasFeedback ? (
              <QuickPromptFeedback
                state={state}
                width={feedbackWidth}
                undo={binding.controller.cancel}
                retry={retry}
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
                    disabled={isQuickPromptActionDisabled(
                      defaultPrompt.mode,
                      write.pending,
                      sendDisabled,
                    )}
                    onActivate={activate}
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
            {!catalog.loaded ? <MenuItem disabled>{t("quickPrompts.loading")}</MenuItem> : null}
            {catalog.loaded && !catalog.prompts.length ? (
              <MenuItem disabled>{t("quickPrompts.empty")}</MenuItem>
            ) : null}
            {catalog.prompts.map((prompt) => (
              <QuickPromptPickerRow
                key={prompt.id}
                prompt={prompt}
                disabled={rowDisabled}
                pinLimit={pinCount >= 3}
                writing={write.pending}
                onSelect={prepareSelection}
              />
            ))}
            <MenuSeparator />
            <QuickPromptDefaultHint prompt={defaultPrompt} />
            <MenuItem disabled={editDisabled} onSelect={add}>
              {t("quickPrompts.add")}
            </MenuItem>
            <MenuItem disabled={draftDisabled} onSelect={saveDraft}>
              {t("quickPrompts.saveDraft")}
            </MenuItem>
            {write.error ? (
              <Text style={styles.error} accessibilityRole="alert">
                {write.error}
              </Text>
            ) : null}
          </MenuSurface>
        </MenuRoot>
      </View>
      {editing ? (
        <QuickPromptEditModal
          key={editing.id}
          prompt={editing}
          isNew={!catalog.prompts.some((prompt) => prompt.id === editing.id)}
          pinCount={pinCount}
          onClose={close}
          onSave={save}
        />
      ) : null}
    </View>
  );
}

function QuickPromptDefaultHint({ prompt }: { prompt: QuickPrompt | undefined }) {
  const { t } = useTranslation();
  return prompt ? null : <MenuItem disabled>{t("quickPrompts.chooseDefault")}</MenuItem>;
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

function QuickPromptPickerRow({
  prompt,
  disabled,
  pinLimit,
  writing,
  onSelect,
}: {
  prompt: QuickPrompt;
  disabled: boolean;
  pinLimit: boolean;
  writing: boolean;
  onSelect: (prompt: QuickPrompt, action: QuickPromptPickerAction) => () => void;
}) {
  const { t } = useTranslation();
  const pressStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.rowSend,
      (pressed || hovered) && styles.selected,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  const { selectItem } = useMenuContext("QuickPromptPickerRow");
  const choose = useCallback(
    (action: QuickPromptPickerAction, close: boolean) =>
      selectItem(onSelect(prompt, action), close),
    [selectItem, onSelect, prompt],
  );
  const send = useCallback(() => choose("send", true), [choose]);
  const insert = useCallback(() => choose("insert", true), [choose]);
  const pin = useCallback(() => choose("pin", false), [choose]);
  const makeDefault = useCallback(() => choose("default", false), [choose]);
  const pinState = useMemo(() => ({ selected: prompt.pinned }), [prompt.pinned]);
  const defaultState = useMemo(() => ({ selected: prompt.isDefault }), [prompt.isDefault]);
  const pinDisabled = writing || (!prompt.pinned && pinLimit);
  const itemDataSet = useMemo(
    () => ({ menuItem: "true", menuDisabled: disabled ? "true" : "false" }),
    [disabled],
  );
  return (
    <View style={styles.pickerRow} testID={`quick-prompt-row-${prompt.id}`}>
      <View style={styles.rowMain}>
        <Pressable
          style={pressStyle}
          disabled={disabled}
          onPress={send}
          accessibilityRole="menuitem"
          dataSet={itemDataSet}
          accessibilityLabel={t("quickPrompts.sendNamed", { title: prompt.title })}
        >
          <Text style={styles.rowTitle} numberOfLines={1}>
            {prompt.title}
          </Text>
          <Text style={styles.preview} numberOfLines={1}>
            {prompt.text}
          </Text>
        </Pressable>
      </View>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={CornerDownLeft}
        disabled={writing}
        accessibilityLabel={t("quickPrompts.insertNamed", { title: prompt.title })}
        onPress={insert}
        testID={`quick-prompt-insert-${prompt.id}`}
      />
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Star}
        disabled={pinDisabled}
        accessibilityHint={pinDisabled ? t("quickPrompts.pinLimit") : undefined}
        accessibilityLabel={t(prompt.pinned ? "quickPrompts.unpin" : "quickPrompts.pin")}
        accessibilityState={pinState}
        style={prompt.pinned ? styles.selected : undefined}
        onPress={pin}
        testID={`quick-prompt-pin-${prompt.id}`}
      />
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Bookmark}
        disabled={writing}
        accessibilityLabel={t("quickPrompts.default")}
        accessibilityState={defaultState}
        style={prompt.isDefault ? styles.selected : undefined}
        onPress={makeDefault}
        testID={`quick-prompt-set-default-${prompt.id}`}
      />
    </View>
  );
}

function QuickPromptFeedback({
  state,
  undo,
  retry,
  dismiss,
  sendNow,
  width,
}: {
  state: QuickPromptSendState;
  dismiss: () => void;
  sendNow: () => void;
  width: number;
  undo: () => void;
  retry: () => void;
}) {
  const { t } = useTranslation();
  if (state.status === "idle") return null;
  let label = t("quickPrompts.cancelled");
  if (state.status === "unavailable") label = t("quickPrompts.unavailable");
  if (state.status === "pending")
    label = `${t(actionKey[state.capture.action])} · ${state.capture.title}`;
  if (state.status === "sending") label = t("quickPrompts.sending");
  if (state.status === "failed") label = t("quickPrompts.failed");
  if (state.status === "accepted") label = t(feedbackKey[state.disposition]);
  return (
    <View
      style={[styles.feedback, { width: width - 2 }]}
      accessibilityLiveRegion="polite"
      testID="quick-prompt-feedback"
    >
      <Pressable
        onPress={sendNow}
        disabled={state.status !== "pending"}
        style={styles.feedbackMain}
        accessibilityRole={state.status === "pending" ? "button" : "text"}
        accessibilityLabel={label}
      >
        <Text style={styles.feedbackText}>{label}</Text>
      </Pressable>
      {state.status === "pending" ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.feedbackAction}
          textStyle={styles.pillText}
          onPress={undo}
          testID="quick-prompt-undo"
        >
          {t("quickPrompts.undo")}
        </Button>
      ) : null}
      {state.status === "failed" ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.feedbackAction}
          textStyle={styles.pillText}
          onPress={retry}
          testID="quick-prompt-retry"
        >
          {t("quickPrompts.retry")}
        </Button>
      ) : null}
      {state.status !== "pending" && state.status !== "sending" ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.feedbackAction}
          leftIcon={X}
          onPress={dismiss}
          accessibilityLabel={t("quickPrompts.dismiss")}
          testID="quick-prompt-dismiss"
        />
      ) : null}
    </View>
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
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    paddingRight: theme.spacing[2],
  },
  rowMain: { flex: 1, minWidth: 0 },
  rowSend: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  disabled: { opacity: theme.opacity[50] },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  selected: { backgroundColor: theme.colors.interactionHighlight },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
    padding: theme.spacing[3],
  },
  feedback: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    paddingHorizontal: theme.spacing[1],
    minHeight: 44,
  },
  feedbackAction: {
    maxWidth: "100%",
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 4,
    flexShrink: 1,
  },
  feedbackMain: { flexGrow: 1, flexShrink: 1, minHeight: 44, justifyContent: "center" },
  feedbackText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
