import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { ArrowUp, ArrowDown, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { QuickPrompt } from "@getpaseo/protocol/messages";
import { SettingsSection, SettingsCard, SettingsRow, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useQuickPrompts } from "./use-quick-prompts";
import { newQuickPrompt } from "./form";
import { moveQuickPrompt, updateQuickPrompt } from "./catalog";
import { QuickPromptEditModal } from "./edit-modal";

type Catalog = ReturnType<typeof useQuickPrompts>;

export function QuickPromptsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const catalog = useQuickPrompts(serverId);
  const [editing, setEditing] = useState<QuickPrompt | null>(null);
  const [write, setWrite] = useState({ pending: false, error: "" });
  const writing = useRef(false);
  const mutate = useCallback(async (action: () => Promise<void>) => {
    if (writing.current) return;
    writing.current = true;
    setWrite({ pending: true, error: "" });
    try {
      await action();
      setWrite({ pending: false, error: "" });
    } catch (error) {
      setWrite({ pending: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      writing.current = false;
    }
  }, []);
  const remove = useCallback(
    async (prompt: QuickPrompt) => {
      const confirmed = await confirmDialog({
        title: t("quickPrompts.delete"),
        message: t("quickPrompts.deleteConfirm", { title: prompt.title }),
        destructive: true,
        confirmLabel: t("quickPrompts.delete"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (confirmed)
        await mutate(() => catalog.save(catalog.prompts.filter((entry) => entry.id !== prompt.id)));
    },
    [catalog, mutate, t],
  );
  const reorder = useCallback(
    (id: string, offset: -1 | 1) => {
      void mutate(() => catalog.save(moveQuickPrompt(catalog.prompts, id, offset)));
    },
    [catalog, mutate],
  );
  const setUndo = useCallback(
    (value: string) => {
      void mutate(() => catalog.setUndoMs(Number(value)));
    },
    [catalog, mutate],
  );
  const add = useCallback(() => setEditing(newQuickPrompt()), []);
  const close = useCallback(() => setEditing(null), []);
  const save = useCallback(
    (prompt: QuickPrompt) => catalog.save(updateQuickPrompt(catalog.prompts, prompt)),
    [catalog],
  );
  const ready = catalog.supported && catalog.connected && catalog.loaded;
  const disabled = !ready || write.pending;
  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        onPress={add}
        disabled={disabled}
        accessibilityLabel={t("quickPrompts.add")}
        testID="quick-prompts-add"
      />
    ),
    [add, disabled, t],
  );
  let unavailable = t("quickPrompts.loading");
  if (!catalog.connected) unavailable = t("quickPrompts.unavailable");
  else if (!catalog.supported) unavailable = t("quickPrompts.unsupported");
  return (
    <>
      <SettingsSection
        title={t("quickPrompts.section")}
        testID="quick-prompts-section"
        trailing={addButton}
      >
        {ready ? (
          <QuickPromptSettingsList
            catalog={catalog}
            disabled={disabled}
            onEdit={setEditing}
            onRemove={remove}
            onMove={reorder}
            onUndoChange={setUndo}
          />
        ) : (
          <SettingsCard>
            <SettingsRow label={unavailable} />
          </SettingsCard>
        )}
        {write.error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {write.error}
          </Text>
        ) : null}
      </SettingsSection>
      {editing ? (
        <QuickPromptEditModal
          key={editing.id}
          prompt={editing}
          isNew={!catalog.prompts.some((prompt) => prompt.id === editing.id)}
          pinCount={catalog.prompts.filter((prompt) => prompt.pinned).length}
          onClose={close}
          onSave={save}
        />
      ) : null}
    </>
  );
}

interface RowActions {
  onEdit: (prompt: QuickPrompt) => void;
  onRemove: (prompt: QuickPrompt) => Promise<void>;
  onMove: (id: string, offset: -1 | 1) => void;
}

function QuickPromptSettingsList({
  catalog,
  disabled,
  onEdit,
  onRemove,
  onMove,
  onUndoChange,
}: RowActions & {
  catalog: Catalog;
  disabled: boolean;
  onUndoChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () => [
      { value: "0", label: t("quickPrompts.off") },
      { value: "1000", label: t("quickPrompts.seconds", { count: 1 }) },
      { value: "2500", label: t("quickPrompts.seconds", { count: 2.5 }) },
      { value: "5000", label: t("quickPrompts.seconds", { count: 5 }) },
      { value: "10000", label: t("quickPrompts.seconds", { count: 10 }) },
    ],
    [t],
  );
  return (
    <SettingsCard>
      <SettingsSelect
        label={t("quickPrompts.undoWindow")}
        value={String(catalog.undoMs)}
        disabled={disabled}
        onValueChange={onUndoChange}
        options={options}
      />
      {catalog.prompts.length === 0 ? <SettingsRow label={t("quickPrompts.empty")} /> : null}
      {catalog.prompts.map((prompt, index) => (
        <QuickPromptSettingsRow
          key={prompt.id}
          prompt={prompt}
          disabled={disabled}
          first={index === 0}
          last={index === catalog.prompts.length - 1}
          onEdit={onEdit}
          onRemove={onRemove}
          onMove={onMove}
        />
      ))}
    </SettingsCard>
  );
}

function QuickPromptSettingsRow({
  prompt,
  disabled,
  first,
  last,
  onEdit,
  onRemove,
  onMove,
}: RowActions & {
  prompt: QuickPrompt;
  disabled: boolean;
  first: boolean;
  last: boolean;
}) {
  const { t } = useTranslation();
  const up = useCallback(() => onMove(prompt.id, -1), [onMove, prompt.id]);
  const down = useCallback(() => onMove(prompt.id, 1), [onMove, prompt.id]);
  const edit = useCallback(() => onEdit(prompt), [onEdit, prompt]);
  const remove = useCallback(() => {
    void onRemove(prompt);
  }, [onRemove, prompt]);
  const preview = useMemo(
    () => (
      <Text style={styles.preview} numberOfLines={1}>
        {prompt.text}
      </Text>
    ),
    [prompt.text],
  );
  return (
    <SettingsRow label={prompt.title} hint={preview}>
      <View style={styles.actions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ArrowUp}
          disabled={disabled || first}
          accessibilityLabel={t("quickPrompts.moveUp")}
          onPress={up}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ArrowDown}
          disabled={disabled || last}
          accessibilityLabel={t("quickPrompts.moveDown")}
          onPress={down}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Pencil}
          disabled={disabled}
          accessibilityLabel={t("quickPrompts.edit")}
          onPress={edit}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Trash2}
          disabled={disabled}
          accessibilityLabel={t("quickPrompts.delete")}
          onPress={remove}
        />
      </View>
    </SettingsRow>
  );
}
const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: "row", gap: theme.spacing[1] },
  preview: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
}));
