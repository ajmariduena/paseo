import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Bookmark, CornerDownLeft, FilePlus, Plus, Send, Star } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { QuickPrompt } from "@getpaseo/protocol/messages";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { MENU_ITEM_HEIGHT, MenuItem, MenuSeparator, useMenuContext } from "@/components/ui/menu";
import { useTouchHitSlop } from "@/components/ui/touch-target";
import { useControlDensity } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { DeferredQuickPromptSend, QuickPromptSendState } from "./deferred-send";
import { useQuickPrompts } from "./use-quick-prompts";
import { useQuickPromptCapacity } from "./capacity";
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

/**
 * Everything a quick-prompt surface needs, resolved once where the composer can still read its
 * own contexts. The attachment menu's sheet page is teleported out of the composer's subtree, so
 * it takes this object by prop rather than calling the hooks itself (docs/floating-panels.md).
 */
export interface QuickPromptPicker {
  binding: QuickPromptToolbarBinding;
  prompts: readonly QuickPrompt[];
  supported: boolean;
  loaded: boolean;
  undoMs: number;
  state: QuickPromptSendState;
  defaultPrompt: QuickPrompt | undefined;
  pinned: readonly QuickPrompt[];
  pinCount: number;
  writePending: boolean;
  writeError: string;
  rowDisabled: boolean;
  editDisabled: boolean;
  draftDisabled: boolean;
  activate: (prompt: QuickPrompt) => void;
  prepareSelection: (prompt: QuickPrompt, action: QuickPromptPickerAction) => () => void;
  add: () => void;
  saveDraft: () => void;
  retry: () => void;
  editor: React.ReactElement | null;
}

function isQuickPromptReady(
  catalog: ReturnType<typeof useQuickPrompts>,
  available: boolean,
  blocked: boolean,
) {
  return catalog.supported && catalog.connected && catalog.loaded && available && !blocked;
}

export function useQuickPromptPicker(binding: QuickPromptToolbarBinding): QuickPromptPicker {
  const catalog = useQuickPrompts(binding.serverId);
  const { blocked } = useQuickPromptCapacity();
  const state = useSyncExternalStore(binding.controller.subscribe, binding.controller.getState);
  const [editing, setEditing] = useState<QuickPrompt | null>(null);
  const [write, setWrite] = useState({ pending: false, error: "" });
  const writing = useRef(false);
  const defaultPrompt = catalog.prompts.find((prompt) => prompt.isDefault);
  const pinned = useMemo(
    () => catalog.prompts.filter((prompt) => prompt.pinned && prompt.id !== defaultPrompt?.id),
    [catalog.prompts, defaultPrompt?.id],
  );
  const ready = isQuickPromptReady(catalog, binding.available, blocked);
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
  const add = useCallback(() => {
    binding.controller.cancel();
    setEditing(newQuickPrompt());
  }, [binding.controller]);
  const saveDraft = useCallback(() => {
    binding.controller.cancel();
    setEditing(newQuickPrompt(binding.getDraft()));
  }, [binding]);
  const closeEditor = useCallback(() => setEditing(null), []);
  const saveEdit = useCallback(
    (prompt: QuickPrompt) => catalog.save(updateQuickPrompt(catalog.prompts, prompt)),
    [catalog],
  );
  const retry = useCallback(
    () => binding.controller.retry(catalog.undoMs),
    [binding.controller, catalog.undoMs],
  );
  const pinCount = catalog.prompts.filter((prompt) => prompt.pinned).length;
  const sendDisabled = state.status === "sending" || write.pending;
  const editDisabled = !catalog.loaded || !catalog.connected;
  const draftEmpty = !binding.getDraft().trim();
  const { prompts, supported, loaded, undoMs } = catalog;
  const editor = useMemo(
    () =>
      editing ? (
        <QuickPromptEditModal
          key={editing.id}
          prompt={editing}
          isNew={!prompts.some((prompt) => prompt.id === editing.id)}
          pinCount={pinCount}
          onClose={closeEditor}
          onSave={saveEdit}
        />
      ) : null,
    [closeEditor, editing, pinCount, prompts, saveEdit],
  );
  // One identity per change, so the memoized composer input does not re-render on every keystroke.
  return useMemo(
    () => ({
      binding,
      prompts,
      supported,
      loaded,
      undoMs,
      state,
      defaultPrompt,
      pinned,
      pinCount,
      writePending: write.pending,
      writeError: write.error,
      rowDisabled: sendDisabled,
      editDisabled,
      draftDisabled: editDisabled || draftEmpty,
      activate,
      prepareSelection,
      add,
      saveDraft,
      retry,
      editor,
    }),
    [
      activate,
      add,
      binding,
      defaultPrompt,
      draftEmpty,
      editDisabled,
      editor,
      loaded,
      pinCount,
      pinned,
      prepareSelection,
      prompts,
      retry,
      saveDraft,
      sendDisabled,
      state,
      supported,
      undoMs,
      write.error,
      write.pending,
    ],
  );
}

export function isQuickPromptSendDisabled(picker: QuickPromptPicker, prompt: QuickPrompt) {
  return isQuickPromptActionDisabled(prompt.mode, picker.writePending, picker.rowDisabled);
}

/** The picker's rows; renders inside any menu surface or page. */
export function QuickPromptPickerList({ picker }: { picker: QuickPromptPicker }) {
  const { t } = useTranslation();
  const addIcon = useMemo(() => <ThemedPlus size={ICON_SIZE.md} uniProps={mutedMapping} />, []);
  const saveIcon = useMemo(
    () => <ThemedFilePlus size={ICON_SIZE.md} uniProps={mutedMapping} />,
    [],
  );
  return (
    <>
      {!picker.loaded ? <MenuItem disabled>{t("quickPrompts.loading")}</MenuItem> : null}
      {picker.loaded && !picker.prompts.length ? (
        <MenuItem disabled>{t("quickPrompts.empty")}</MenuItem>
      ) : null}
      {picker.prompts.map((prompt) => (
        <QuickPromptPickerRow
          key={prompt.id}
          prompt={prompt}
          disabled={picker.rowDisabled}
          pinLimit={picker.pinCount >= 3}
          writing={picker.writePending}
          onSelect={picker.prepareSelection}
        />
      ))}
      <MenuSeparator />
      {picker.defaultPrompt ? null : (
        <MenuItem disabled>{t("quickPrompts.chooseDefault")}</MenuItem>
      )}
      <MenuItem leading={addIcon} disabled={picker.editDisabled} onSelect={picker.add}>
        {t("quickPrompts.add")}
      </MenuItem>
      <MenuItem leading={saveIcon} disabled={picker.draftDisabled} onSelect={picker.saveDraft}>
        {t("quickPrompts.saveDraft")}
      </MenuItem>
      {picker.writeError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {picker.writeError}
        </Text>
      ) : null}
    </>
  );
}

const ThemedPlus = withUnistyles(Plus);
const ThemedFilePlus = withUnistyles(FilePlus);
const ThemedSend = withUnistyles(Send);
const ThemedCornerDownLeft = withUnistyles(CornerDownLeft);
const ThemedStar = withUnistyles(Star);
const ThemedBookmark = withUnistyles(Bookmark);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const selectedMapping = (theme: Theme) => ({ color: theme.colors.accentBright });

/**
 * A prompt on the menu's rail: its tap mode as the leading glyph, title and preview, then one
 * trailing group of equal targets — insert, pin, default. A chosen pin or default is an accent
 * glyph, nothing more.
 */
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
  const isTouch = useControlDensity() === "touch";
  const pressStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.rowMain,
      (pressed || hovered) && styles.rowMainActive,
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
  const pinDisabled = writing || (!prompt.pinned && pinLimit);
  const itemDataSet = useMemo(
    () => ({ menuItem: "true", menuDisabled: disabled ? "true" : "false" }),
    [disabled],
  );
  const ModeGlyph = prompt.mode === "insert" ? ThemedCornerDownLeft : ThemedSend;
  return (
    <View style={[styles.row, isTouch && styles.rowTouch]} testID={`quick-prompt-row-${prompt.id}`}>
      <Pressable
        style={pressStyle}
        disabled={disabled}
        onPress={send}
        accessibilityRole="menuitem"
        dataSet={itemDataSet}
        accessibilityLabel={t("quickPrompts.sendNamed", { title: prompt.title })}
      >
        <View style={styles.leading}>
          <ModeGlyph size={ICON_SIZE.md} uniProps={mutedMapping} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {prompt.title}
          </Text>
          <Text style={styles.preview} numberOfLines={1}>
            {prompt.text}
          </Text>
        </View>
      </Pressable>
      <View style={styles.actions}>
        <PickerAction
          icon={ThemedCornerDownLeft}
          selected={false}
          disabled={writing}
          accessibilityLabel={t("quickPrompts.insertNamed", { title: prompt.title })}
          onPress={insert}
          testID={`quick-prompt-insert-${prompt.id}`}
        />
        <PickerAction
          icon={ThemedStar}
          selected={prompt.pinned}
          disabled={pinDisabled}
          accessibilityLabel={t(prompt.pinned ? "quickPrompts.unpin" : "quickPrompts.pin")}
          accessibilityHint={pinDisabled ? t("quickPrompts.pinLimit") : undefined}
          onPress={pin}
          testID={`quick-prompt-pin-${prompt.id}`}
        />
        <PickerAction
          icon={ThemedBookmark}
          selected={prompt.isDefault}
          disabled={writing}
          accessibilityLabel={t("quickPrompts.default")}
          onPress={makeDefault}
          testID={`quick-prompt-set-default-${prompt.id}`}
        />
      </View>
    </View>
  );
}

type ThemedIcon = typeof ThemedStar;

function PickerAction({
  icon: Icon,
  selected,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  testID,
}: {
  icon: ThemedIcon;
  selected: boolean;
  disabled: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  testID: string;
}) {
  const hitSlop = useTouchHitSlop(ACTION_SIZE);
  const state = useMemo(() => ({ selected }), [selected]);
  const actionStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.action,
      (pressed || hovered) && styles.actionActive,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  return (
    <Pressable
      style={actionStyle}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={state}
      testID={testID}
    >
      <Icon size={ICON_SIZE.md} uniProps={selected ? selectedMapping : mutedMapping} />
    </Pressable>
  );
}

const ACTION_SIZE = CONTROL_HEIGHTS.tight;

const styles = StyleSheet.create((theme) => ({
  // The same box as a menu row: inset 4, border 1, padding 8, so the glyph lands on the rail.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: MENU_ITEM_HEIGHT.md,
    marginHorizontal: theme.spacing[1],
    paddingRight: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    borderRadius: theme.borderRadius.md,
  },
  rowTouch: {
    minHeight: MENU_ITEM_HEIGHT.xs,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rowMainActive: { backgroundColor: theme.colors.interactionHighlight },
  leading: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.3),
  },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.3),
  },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  action: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  actionActive: { backgroundColor: theme.colors.interactionHighlight },
  disabled: { opacity: theme.opacity[50] },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
    padding: theme.spacing[3],
  },
}));
