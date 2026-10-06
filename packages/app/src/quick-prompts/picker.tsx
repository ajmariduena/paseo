import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Bookmark, CornerDownLeft, Star } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { QuickPrompt } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { MenuItem, MenuSeparator, useMenuContext } from "@/components/ui/menu";
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
  const { prompts, supported, loaded } = catalog;
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
      <MenuItem disabled={picker.editDisabled} onSelect={picker.add}>
        {t("quickPrompts.add")}
      </MenuItem>
      <MenuItem disabled={picker.draftDisabled} onSelect={picker.saveDraft}>
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

const styles = StyleSheet.create((theme) => ({
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
}));
