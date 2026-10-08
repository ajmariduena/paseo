import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { NotebookPen, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import {
  FLOATING_ACTION_BUTTON_CLEARANCE,
  FloatingActionButton,
} from "@/components/ui/floating-action-button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SearchField } from "@/components/ui/search-field";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useNoteActions, useNotes, type HostNote, type NotesLoadState } from "@/notes/data";
import { filterNotes, isSelectedNote, type NoteSelection } from "@/notes/model";
import { NoteDetail } from "@/notes/note-detail";
import { NoteList } from "@/notes/note-list";

const EMPTY_NOTES: HostNote[] = [];
// ⌘N means "new workspace" app-wide; while Scratchpad is open it means "new note".
const NEW_NOTE_ACTIONS: readonly KeyboardActionId[] = ["workspace.new"];
const ThemedPlus = withUnistyles(Plus);

export function NotesScreen({
  initialSelection,
}: {
  initialSelection: { serverId: string; noteId: string } | null;
}): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <NotesScreenContent initialSelection={initialSelection} />;
}

function NotesScreenContent({
  initialSelection,
}: {
  initialSelection: { serverId: string; noteId: string } | null;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const { loadState, refetch } = useNotes({ poll: true });
  const actions = useNoteActions();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<NoteSelection | null>(() =>
    initialSelection ? { kind: "note", ...initialSelection } : null,
  );
  // The editor keeps its key when a draft becomes a saved note, so typing is never interrupted.
  const [editorKey, setEditorKey] = useState(0);

  useEffect(() => {
    if (!initialSelection) return;
    setSelection({ kind: "note", ...initialSelection });
    setEditorKey((key) => key + 1);
  }, [initialSelection]);

  const notes = loadState.status === "loaded" ? loadState.notes : EMPTY_NOTES;
  const visibleNotes = useMemo(() => filterNotes(notes, query), [notes, query]);
  const selectedNote = useMemo(
    () => notes.find((note) => isSelectedNote(note, selection)) ?? null,
    [notes, selection],
  );
  const selectionMissing =
    selection?.kind === "note" && loadState.status === "loaded" && !selectedNote;

  useEffect(() => {
    if (selectionMissing) setSelection(null);
  }, [selectionMissing]);

  useEffect(() => {
    if (isCompact || selection || visibleNotes.length === 0) return;
    const first = visibleNotes[0];
    setSelection({ kind: "note", serverId: first.serverId, noteId: first.id });
    setEditorKey((key) => key + 1);
  }, [isCompact, selection, visibleNotes]);

  const newNoteServerId =
    selection?.serverId ?? notes[0]?.serverId ?? firstSupportedHost(loadState);

  const openDraft = useCallback(() => {
    if (!newNoteServerId) return false;
    setSelection({ kind: "draft", serverId: newNoteServerId });
    setEditorKey((key) => key + 1);
    return true;
  }, [newNoteServerId]);
  const handleNewNote = useCallback(() => void openDraft(), [openDraft]);

  useKeyboardActionHandler({
    handlerId: "scratchpad-new-note",
    actions: NEW_NOTE_ACTIONS,
    enabled: newNoteServerId !== null,
    priority: 10,
    handle: openDraft,
  });

  const handleSelect = useCallback((note: HostNote) => {
    setSelection({ kind: "note", serverId: note.serverId, noteId: note.id });
    setEditorKey((key) => key + 1);
  }, []);
  const handleCreated = useCallback((note: HostNote) => {
    setSelection({ kind: "note", serverId: note.serverId, noteId: note.id });
  }, []);
  const handleClosed = useCallback(() => {
    setSelection(null);
    setEditorKey((key) => key + 1);
  }, []);

  const detail =
    selection && (selection.kind === "draft" || selectedNote) ? (
      <NoteDetail
        key={editorKey}
        note={selection.kind === "draft" ? null : selectedNote}
        serverId={selection.serverId}
        actions={actions}
        compact={isCompact}
        autoFocus={selection.kind === "draft"}
        onCreated={handleCreated}
        onClosed={handleClosed}
        onRefetch={refetch}
      />
    ) : null;

  if (isCompact && detail) {
    return <View style={styles.container}>{detail}</View>;
  }

  const listPane = (
    <NotesListPane
      loadState={loadState}
      notes={visibleNotes}
      hasNotes={notes.length > 0}
      selection={isCompact ? null : selection}
      query={query}
      compact={isCompact}
      onQueryChange={setQuery}
      onSelect={handleSelect}
      onCreate={handleNewNote}
    />
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("notes.title")} />
      {isCompact ? (
        <View style={styles.body}>
          {listPane}
          {newNoteServerId ? (
            <FloatingActionButton
              icon={Plus}
              accessibilityLabel={t("notes.new")}
              onPress={handleNewNote}
              testID="notes-fab"
            />
          ) : null}
        </View>
      ) : (
        <View style={styles.split}>
          <View style={styles.listColumn}>{listPane}</View>
          <View style={styles.detailColumn}>
            {detail ?? (
              <View style={styles.centered}>
                <Text style={styles.message}>{t("notes.selectNote")}</Text>
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function firstSupportedHost(loadState: NotesLoadState): string | null {
  if (loadState.status !== "loaded" || loadState.supportedHosts === 0) return null;
  return loadState.notes[0]?.serverId ?? loadState.supportedServerIds[0] ?? null;
}

function newNoteButtonStyle({ hovered = false, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [styles.newNoteButton, (hovered || pressed) && styles.newNoteButtonHovered];
}

function NewNoteIconButton({ onPress }: { onPress: () => void }): ReactElement {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys("new-workspace");
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onPress}
          style={newNoteButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={t("notes.new")}
          testID="notes-new"
        >
          <ThemedPlus size={16} uniProps={mutedIconColorMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipText}>{t("notes.new")}</Text>
          {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

function NotesListPane({
  loadState,
  notes,
  hasNotes,
  selection,
  query,
  compact,
  onQueryChange,
  onSelect,
  onCreate,
}: {
  loadState: NotesLoadState;
  notes: readonly HostNote[];
  hasNotes: boolean;
  selection: NoteSelection | null;
  query: string;
  compact: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (note: HostNote) => void;
  onCreate: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (loadState.status === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }
  if (loadState.supportedHosts === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("notes.unsupported")}</Text>
      </View>
    );
  }
  if (!hasNotes && selection?.kind !== "draft") {
    return (
      <View style={styles.centered} testID="notes-empty">
        <NotebookPen size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
        <View style={styles.emptyText}>
          <Text style={styles.emptyTitle}>{t("notes.empty.title")}</Text>
          <Text style={styles.message}>{t("notes.empty.description")}</Text>
        </View>
        <Button variant="outline" leftIcon={Plus} onPress={onCreate} testID="notes-empty-new">
          {t("notes.new")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <View style={styles.controls}>
        <SearchField
          value={query}
          onChangeText={onQueryChange}
          placeholder={t("notes.search")}
          clearAccessibilityLabel={t("notes.clearSearch")}
          testID="notes-search"
        />
        {compact ? null : <NewNoteIconButton onPress={onCreate} />}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={compact ? styles.scrollContentCompact : styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {loadState.hostErrors.map((error) => (
          <Text key={error.serverId} style={styles.errorText}>
            {t("notes.hostError", { hostName: error.serverName })}
          </Text>
        ))}
        <NoteList notes={notes} selection={selection} onSelect={onSelect} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  split: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  listColumn: {
    width: 320,
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  detailColumn: {
    flex: 1,
    minWidth: 0,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  // Matches SearchField's height: 20px input + 6px padding and 1px border on each side.
  newNoteButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  newNoteButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: theme.spacing[6],
  },
  scrollContentCompact: {
    paddingBottom: FLOATING_ACTION_BUTTON_CLEARANCE + theme.spacing[6],
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  emptyText: {
    alignItems: "center",
    gap: theme.spacing[2],
    maxWidth: 320,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  // Static color holders read by imperative icon props; keeps tokens without useUnistyles.
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
}));
