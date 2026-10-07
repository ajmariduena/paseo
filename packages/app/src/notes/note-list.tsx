import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, FileText } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { noteDisplayTitle } from "@getpaseo/protocol/notes/types";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { HostNote } from "./data";
import {
  isSelectedNote,
  linkedAgentStateVariant,
  noteKey,
  resolveLinkedAgentState,
  type NoteGroup,
  type NoteSelection,
} from "./model";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const checkColorMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const ThemedFileText = withUnistyles(FileText);
const ThemedCheck = withUnistyles(Check);

export function NoteTodoCheckbox({
  note,
  onToggle,
  size = "sm",
}: {
  note: Pick<HostNote, "todoState" | "title" | "body">;
  onToggle: () => void;
  size?: "sm" | "md";
}): ReactElement {
  const { t } = useTranslation();
  const done = note.todoState === "done";
  const title = noteDisplayTitle(note);
  const accessibilityState = useMemo(() => ({ checked: done }), [done]);
  const boxStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.checkbox,
      size === "md" && styles.checkboxMd,
      hovered && !done && styles.checkboxHovered,
      done && styles.checkboxDone,
    ],
    [done, size],
  );
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={8}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      accessibilityLabel={
        done ? t("notes.toggleOpen", { title }) : t("notes.toggleDone", { title })
      }
      style={boxStyle}
      testID="note-todo-checkbox"
    >
      {done ? (
        <ThemedCheck size={size === "md" ? 13 : 11} strokeWidth={3} uniProps={checkColorMapping} />
      ) : null}
    </Pressable>
  );
}

function LinkedAgentBadge({ note }: { note: HostNote }): ReactElement | null {
  const { t } = useTranslation();
  const lastLink = note.linkedAgents[note.linkedAgents.length - 1];
  const agent = useSessionStore((state) =>
    lastLink ? state.sessions[note.serverId]?.agents.get(lastLink.agentId) : undefined,
  );
  if (!agent || note.todoState === "done") return null;
  const state = resolveLinkedAgentState(agent, note);
  if (state === "idle" || state === "archived") return null;
  return (
    <StatusBadge
      size="xs"
      label={t(`notes.agentState.${state}`)}
      variant={linkedAgentStateVariant(state)}
    />
  );
}

function NoteRowMeta({ note }: { note: HostNote }): ReactElement {
  const updatedAt = useMemo(() => new Date(note.updatedAt), [note.updatedAt]);
  const timeAgo = useTimeAgo(updatedAt);
  return (
    <View style={styles.meta}>
      <LinkedAgentBadge note={note} />
      <Text style={styles.metaText} numberOfLines={1}>
        {timeAgo}
      </Text>
    </View>
  );
}

function NoteRow({
  note,
  selected,
  onSelect,
  onToggleDone,
}: {
  note: HostNote;
  selected: boolean;
  onSelect: (note: HostNote) => void;
  onToggleDone: (note: HostNote) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(note), [note, onSelect]);
  const handleToggle = useCallback(() => onToggleDone(note), [note, onToggleDone]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const rowStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      hovered && styles.rowHovered,
      (pressed || selected) && styles.rowSelected,
    ],
    [selected],
  );
  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID={`note-row-${note.id}`}
    >
      <View style={styles.leading}>
        {note.todoState ? (
          <NoteTodoCheckbox note={note} onToggle={handleToggle} />
        ) : (
          <ThemedFileText size={14} uniProps={mutedColorMapping} />
        )}
      </View>
      <View style={styles.rowContent}>
        <Text
          style={[styles.title, note.todoState === "done" && styles.titleDone]}
          numberOfLines={2}
        >
          {noteDisplayTitle(note)}
        </Text>
        <NoteRowMeta note={note} />
      </View>
    </Pressable>
  );
}

export function NoteList({
  groups,
  selection,
  onSelect,
  onToggleDone,
}: {
  groups: readonly NoteGroup[];
  selection: NoteSelection | null;
  onSelect: (note: HostNote) => void;
  onToggleDone: (note: HostNote) => void;
}): ReactElement {
  return (
    <View style={styles.list} testID="notes-list">
      {groups.map((group) => (
        <View key={group.key} style={styles.group}>
          <Text style={styles.groupLabel} numberOfLines={1}>
            {group.label}
          </Text>
          {group.notes.map((note) => (
            <NoteRow
              key={noteKey(note)}
              note={note}
              selected={isSelectedNote(note, selection)}
              onSelect={onSelect}
              onToggleDone={onToggleDone}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
  },
  group: {
    gap: 2,
  },
  groupLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  leading: {
    width: 16,
    paddingTop: 2,
    alignItems: "center",
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  titleDone: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  checkbox: {
    width: 15,
    height: 15,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: theme.colors.surface4,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxMd: {
    width: 18,
    height: 18,
    borderRadius: 5,
  },
  checkboxHovered: {
    borderColor: theme.colors.foregroundMuted,
  },
  checkboxDone: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
}));
