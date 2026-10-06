import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { ArrowUp, ArrowDown, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { QuickPrompt } from "@getpaseo/protocol/messages";
import { SettingsSection, SettingsCard, SettingsRow, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { ICON_SIZE, type Theme } from "@/styles/theme";
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

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function kebabTriggerStyle({
  pressed,
  hovered,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebab, (pressed || Boolean(hovered)) && styles.kebabActive];
}

function renderKebabIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedMoreVertical size={ICON_SIZE.sm} uniProps={hovered ? foregroundMapping : mutedMapping} />
  );
}

/** What the composer will do with the prompt, read off the row: default, pinned, insert. */
function QuickPromptBadges({ prompt }: { prompt: QuickPrompt }): ReactElement | null {
  const { t } = useTranslation();
  if (!prompt.isDefault && !prompt.pinned && prompt.mode !== "insert") return null;
  return (
    <View style={styles.badges}>
      {prompt.isDefault ? (
        <StatusBadge size="xs" variant="success" label={t("quickPrompts.defaultBadge")} />
      ) : null}
      {prompt.pinned ? <StatusBadge size="xs" label={t("quickPrompts.pinnedBadge")} /> : null}
      {prompt.mode === "insert" ? <StatusBadge size="xs" label={t("quickPrompts.insert")} /> : null}
    </View>
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
  const badges = useMemo(() => <QuickPromptBadges prompt={prompt} />, [prompt]);
  const icons = useMemo(
    () => ({
      up: <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedMapping} />,
      down: <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedMapping} />,
      edit: <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedMapping} />,
      remove: <ThemedTrash2 size={ICON_SIZE.sm} uniProps={mutedMapping} />,
    }),
    [],
  );
  return (
    <SettingsRow label={prompt.title} labelAccessory={badges} hint={preview}>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={kebabTriggerStyle}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t("quickPrompts.actions")}
          testID={`quick-prompt-settings-menu-${prompt.id}`}
        >
          {renderKebabIcon}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" minWidth={200}>
          <DropdownMenuItem leading={icons.up} disabled={first} onSelect={up}>
            {t("quickPrompts.moveUp")}
          </DropdownMenuItem>
          <DropdownMenuItem leading={icons.down} disabled={last} onSelect={down}>
            {t("quickPrompts.moveDown")}
          </DropdownMenuItem>
          <DropdownMenuItem leading={icons.edit} onSelect={edit}>
            {t("quickPrompts.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem leading={icons.remove} destructive onSelect={remove}>
            {t("quickPrompts.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}
const styles = StyleSheet.create((theme) => ({
  badges: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  kebab: {
    padding: theme.spacing[0.5],
    borderRadius: theme.borderRadius.base,
  },
  kebabActive: { backgroundColor: theme.colors.surface2 },
  preview: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
}));
