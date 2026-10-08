import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { noteDisplayTitle } from "@getpaseo/protocol/notes/types";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { useSessionStore } from "@/stores/session-store";
import type { HostNote } from "./data";
import {
  isSelectedNote,
  linkedAgentStateVariant,
  noteKey,
  noteSummaryLine,
  resolveLinkedAgentState,
  type NoteSelection,
} from "./model";

function rowStyle(selected: boolean) {
  return ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
    styles.row,
    hovered && styles.rowHovered,
    (pressed || selected) && styles.rowSelected,
  ];
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
  const { t } = useTranslation();
  const updatedAt = useMemo(() => new Date(note.updatedAt), [note.updatedAt]);
  const timeAgo = useTimeAgo(updatedAt);
  const summary = noteSummaryLine(note);
  let summaryText: string | null = null;
  if (summary?.kind === "progress") {
    summaryText = t("notes.progress", { done: summary.done, total: summary.total });
  } else if (summary) {
    summaryText = summary.text;
  }
  return (
    <View style={styles.meta}>
      <LinkedAgentBadge note={note} />
      <Text style={styles.metaText} numberOfLines={1}>
        {summaryText ? `${timeAgo} · ${summaryText}` : timeAgo}
      </Text>
    </View>
  );
}

function NoteRow({
  note,
  selected,
  onSelect,
}: {
  note: HostNote;
  selected: boolean;
  onSelect: (note: HostNote) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(note), [note, onSelect]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const style = useMemo(() => rowStyle(selected), [selected]);
  return (
    <Pressable
      onPress={handlePress}
      style={style}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID={`note-row-${note.id}`}
    >
      <Text style={styles.title} numberOfLines={1}>
        {noteDisplayTitle(note)}
      </Text>
      <NoteRowMeta note={note} />
    </Pressable>
  );
}

const draftRowStyle = rowStyle(true);
const draftAccessibilityState = { selected: true };

function DraftRow(): ReactElement {
  const { t } = useTranslation();
  const [createdAt] = useState(() => new Date());
  const timeAgo = useTimeAgo(createdAt);
  return (
    <Pressable
      style={draftRowStyle}
      accessibilityRole="button"
      accessibilityState={draftAccessibilityState}
      testID="notes-draft-row"
    >
      <Text style={[styles.title, styles.titleDraft]} numberOfLines={1}>
        {t("notes.new")}
      </Text>
      <View style={styles.meta}>
        <Text style={styles.metaText} numberOfLines={1}>
          {timeAgo}
        </Text>
      </View>
    </Pressable>
  );
}

export function NoteList({
  notes,
  selection,
  onSelect,
}: {
  notes: readonly HostNote[];
  selection: NoteSelection | null;
  onSelect: (note: HostNote) => void;
}): ReactElement {
  return (
    <View style={styles.list} testID="notes-list">
      {selection?.kind === "draft" ? <DraftRow /> : null}
      {notes.map((note) => (
        <NoteRow
          key={noteKey(note)}
          note={note}
          selected={isSelectedNote(note, selection)}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: 2,
    paddingHorizontal: theme.spacing[2],
  },
  row: {
    gap: 2,
    paddingVertical: { xs: 10, md: theme.spacing[2] },
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  titleDraft: {
    color: theme.colors.foregroundMuted,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaText: {
    flexShrink: 1,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
}));
