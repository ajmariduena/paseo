import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { NotebookPen, Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import {
  FLOATING_ACTION_BUTTON_CLEARANCE,
  FloatingActionButton,
} from "@/components/ui/floating-action-button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { useProjects } from "@/hooks/use-projects";
import { useNoteActions, useNotes, type HostNote, type NotesLoadState } from "@/notes/data";
import {
  countOpenTodos,
  filterNotes,
  groupNotesByProject,
  isSelectedNote,
  type NoteSelection,
  type NotesFilter,
} from "@/notes/model";
import { NoteCaptureSheet, type NoteProjectOption } from "@/notes/note-capture-sheet";
import { NoteDetail } from "@/notes/note-detail";
import { NoteList } from "@/notes/note-list";
import { toErrorMessage } from "@/utils/error-messages";

const EMPTY_NOTES: HostNote[] = [];

export function NotesScreen({
  initialSelection,
}: {
  initialSelection: NoteSelection | null;
}): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <NotesScreenContent initialSelection={initialSelection} />;
}

function useProjectNames(): {
  projectName: (serverId: string, projectId: string) => string | null;
  projectOptions: (serverId: string) => NoteProjectOption[];
} {
  const { projects } = useProjects();
  return useMemo(() => {
    const names = new Map<string, string>();
    const byHost = new Map<string, NoteProjectOption[]>();
    for (const project of projects) {
      for (const host of project.hosts) {
        const label = host.projectCustomName || host.projectName;
        names.set(`${host.serverId}:${host.projectId}`, label);
        const options = byHost.get(host.serverId) ?? [];
        options.push({ projectId: host.projectId, label });
        byHost.set(host.serverId, options);
      }
    }
    return {
      projectName: (serverId, projectId) => names.get(`${serverId}:${projectId}`) ?? null,
      projectOptions: (serverId) =>
        [...(byHost.get(serverId) ?? [])].sort((a, b) => a.label.localeCompare(b.label)),
    };
  }, [projects]);
}

function NotesScreenContent({
  initialSelection,
}: {
  initialSelection: NoteSelection | null;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const { loadState, refetch } = useNotes({ poll: true });
  const actions = useNoteActions();
  const { projectName, projectOptions } = useProjectNames();
  const [filter, setFilter] = useState<NotesFilter>("all");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<NoteSelection | null>(initialSelection);
  const [captureOpen, setCaptureOpen] = useState(false);

  useEffect(() => {
    if (initialSelection) setSelection(initialSelection);
  }, [initialSelection]);

  const notes = loadState.status === "loaded" ? loadState.notes : EMPTY_NOTES;
  const visibleNotes = useMemo(() => filterNotes(notes, { filter, query }), [filter, notes, query]);
  const groups = useMemo(
    () => groupNotesByProject(visibleNotes, { projectName, noProjectLabel: t("notes.noProject") }),
    [projectName, t, visibleNotes],
  );
  const selectedNote = useMemo(
    () => notes.find((note) => isSelectedNote(note, selection)) ?? null,
    [notes, selection],
  );

  useEffect(() => {
    if (isCompact || selection || visibleNotes.length === 0) return;
    const first = visibleNotes[0];
    setSelection({ serverId: first.serverId, noteId: first.id });
  }, [isCompact, selection, visibleNotes]);

  const captureServerId =
    selectedNote?.serverId ?? notes[0]?.serverId ?? firstSupportedHost(loadState);
  const filterOptions = useMemo(
    () => [
      { value: "all" as const, label: t("notes.filters.all"), testID: "notes-filter-all" },
      {
        value: "todos" as const,
        label: `${t("notes.filters.todos")} · ${countOpenTodos(notes)}`,
        testID: "notes-filter-todos",
      },
      { value: "done" as const, label: t("notes.filters.done"), testID: "notes-filter-done" },
    ],
    [notes, t],
  );

  const handleSelect = useCallback((note: HostNote) => {
    setSelection({ serverId: note.serverId, noteId: note.id });
  }, []);
  const handleToggleDone = useCallback(
    (note: HostNote) => {
      const todoState = note.todoState === "done" ? "open" : "done";
      void actions.update(note, { todoState }).catch((error: unknown) => {
        toast.error(toErrorMessage(error) || t("notes.detail.saveFailed"));
      });
    },
    [actions, t, toast],
  );
  const handleClosed = useCallback(() => setSelection(null), []);
  const openCapture = useCallback(() => setCaptureOpen(true), []);
  const closeCapture = useCallback(() => setCaptureOpen(false), []);
  const handleCreated = useCallback(
    (noteId: string) => {
      if (captureServerId) setSelection({ serverId: captureServerId, noteId });
    },
    [captureServerId],
  );

  const headerAction = useMemo(
    () =>
      isCompact || !captureServerId ? null : (
        <Button
          variant="outline"
          size="sm"
          leftIcon={Plus}
          onPress={openCapture}
          testID="notes-new"
        >
          {t("notes.new")}
        </Button>
      ),
    [captureServerId, isCompact, openCapture, t],
  );

  const captureSheet = captureServerId ? (
    <NoteCaptureSheet
      visible={captureOpen}
      serverId={captureServerId}
      projectOptions={projectOptions(captureServerId)}
      defaultProjectId={selectedNote?.projectId ?? null}
      defaultTodo={filter === "todos"}
      actions={actions}
      onClose={closeCapture}
      onCreated={handleCreated}
    />
  ) : null;

  const detail = selectedNote ? (
    <NoteDetail
      key={`${selectedNote.serverId}:${selectedNote.id}`}
      note={selectedNote}
      projectName={
        selectedNote.projectId ? projectName(selectedNote.serverId, selectedNote.projectId) : null
      }
      actions={actions}
      onClosed={handleClosed}
      onRefetch={refetch}
    />
  ) : null;

  if (isCompact && detail) {
    return (
      <View style={styles.container}>
        <BackHeader title={t("notes.detail.back")} onBack={handleClosed} />
        {detail}
      </View>
    );
  }

  const listPane = (
    <NotesListPane
      loadState={loadState}
      groups={groups}
      hasNotes={notes.length > 0}
      selection={isCompact ? null : selection}
      filter={filter}
      filterOptions={filterOptions}
      query={query}
      compact={isCompact}
      onFilterChange={setFilter}
      onQueryChange={setQuery}
      onSelect={handleSelect}
      onToggleDone={handleToggleDone}
      onCreate={openCapture}
    />
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("notes.title")} rightContent={headerAction} />
      {isCompact ? (
        <View style={styles.body}>
          {listPane}
          {captureServerId ? (
            <FloatingActionButton
              icon={Plus}
              accessibilityLabel={t("notes.new")}
              onPress={openCapture}
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
      {captureSheet}
    </View>
  );
}

function firstSupportedHost(loadState: NotesLoadState): string | null {
  if (loadState.status !== "loaded" || loadState.supportedHosts === 0) return null;
  return loadState.notes[0]?.serverId ?? loadState.supportedServerIds[0] ?? null;
}

function NotesListPane({
  loadState,
  groups,
  hasNotes,
  selection,
  filter,
  filterOptions,
  query,
  compact,
  onFilterChange,
  onQueryChange,
  onSelect,
  onToggleDone,
  onCreate,
}: {
  loadState: NotesLoadState;
  groups: ReturnType<typeof groupNotesByProject>;
  hasNotes: boolean;
  selection: NoteSelection | null;
  filter: NotesFilter;
  filterOptions: { value: NotesFilter; label: string; testID: string }[];
  query: string;
  compact: boolean;
  onFilterChange: (filter: NotesFilter) => void;
  onQueryChange: (query: string) => void;
  onSelect: (note: HostNote) => void;
  onToggleDone: (note: HostNote) => void;
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
  if (!hasNotes) {
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
        <SegmentedControl
          size="sm"
          value={filter}
          onValueChange={onFilterChange}
          options={filterOptions}
          testID="notes-filter"
        />
        <SearchField
          value={query}
          onChangeText={onQueryChange}
          placeholder={t("notes.search")}
          clearAccessibilityLabel={t("notes.clearSearch")}
          testID="notes-search"
        />
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
        {groups.length > 0 ? (
          <NoteList
            groups={groups}
            selection={selection}
            onSelect={onSelect}
            onToggleDone={onToggleDone}
          />
        ) : (
          <Text style={styles.filterEmpty}>{t("notes.emptyFilter")}</Text>
        )}
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
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[3] },
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
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
  filterEmpty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
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
