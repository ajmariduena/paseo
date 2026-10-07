import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Bot,
  Check,
  FolderGit2,
  GitBranch,
  ListTodo,
  MoreHorizontal,
  NotebookPen,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-api-context";
import { useIncomingShareStore } from "@/incoming-share/store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { createNoteAttachment } from "./attachment";
import { isNoteRevisionConflict, type HostNote, type NoteActions } from "./data";
import { linkedAgentStateVariant, resolveLinkedAgentState } from "./model";
import { NoteTodoCheckbox } from "./note-list";

const AUTOSAVE_DELAY_MS = 600;
const MENU_ICON_SIZE = 14;

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedCheck = withUnistyles(Check);
const ThemedRotateCcw = withUnistyles(RotateCcw);
const ThemedListTodo = withUnistyles(ListTodo);
const ThemedNotebookPen = withUnistyles(NotebookPen);
const ThemedArchive = withUnistyles(Archive);
const ThemedTrash = withUnistyles(Trash2);
const ThemedFolder = withUnistyles(FolderGit2);
const ThemedBranch = withUnistyles(GitBranch);
const ThemedBot = withUnistyles(Bot);

const doneLeading = <ThemedCheck size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const reopenLeading = <ThemedRotateCcw size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const todoLeading = <ThemedListTodo size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const noteLeading = <ThemedNotebookPen size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const archiveLeading = <ThemedArchive size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;
const projectPillIcon = <ThemedFolder size={12} uniProps={mutedColorMapping} />;
const workspacePillIcon = <ThemedBranch size={12} uniProps={mutedColorMapping} />;
const authorPillIcon = <ThemedBot size={12} uniProps={mutedColorMapping} />;

type SaveState = "idle" | "saving" | "saved";

function renderMoreIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return <ThemedMore size={16} uniProps={hovered ? foregroundColorMapping : mutedColorMapping} />;
}

function kebabStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebab, hovered && styles.kebabHovered];
}

function MetaPill({ icon, label }: { icon: ReactElement; label: string }): ReactElement {
  return (
    <View style={styles.pill}>
      {icon}
      <Text style={styles.pillText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function NoteMeta({
  note,
  projectName,
}: {
  note: HostNote;
  projectName: string | null;
}): ReactElement | null {
  const { t } = useTranslation();
  const workspaceName = useSessionStore((state) => {
    if (!note.workspaceId) return null;
    const workspace = state.sessions[note.serverId]?.workspaces.get(note.workspaceId);
    return workspace ? (workspace.title ?? workspace.name) : null;
  });
  const pills: ReactElement[] = [];
  if (projectName) {
    pills.push(<MetaPill key="project" icon={projectPillIcon} label={projectName} />);
  }
  if (workspaceName) {
    pills.push(
      <MetaPill
        key="workspace"
        icon={workspacePillIcon}
        label={t("notes.detail.capturedIn", { name: workspaceName })}
      />,
    );
  }
  if (note.author.type === "agent") {
    pills.push(<MetaPill key="author" icon={authorPillIcon} label={t("notes.detail.byAgent")} />);
  }
  if (pills.length === 0) return null;
  return <View style={styles.metaRow}>{pills}</View>;
}

function LinkedAgentRow({
  note,
  agentId,
  isFirst,
}: {
  note: HostNote;
  agentId: string;
  isFirst: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  const agent = useSessionStore((state) => state.sessions[note.serverId]?.agents.get(agentId));
  const handlePress = useCallback(() => {
    navigateToAgent({ serverId: note.serverId, agentId, workspaceId: agent?.workspaceId });
  }, [agent?.workspaceId, agentId, note.serverId]);
  const rowStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.agentRow,
      !isFirst && styles.agentRowBorder,
      hovered && styles.agentRowHovered,
    ],
    [isFirst],
  );
  if (!agent) return null;
  const state = resolveLinkedAgentState(agent, note);
  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      testID={`note-linked-agent-${agentId}`}
    >
      <Text style={styles.agentTitle} numberOfLines={1}>
        {agent.title ?? agentId}
      </Text>
      <StatusBadge
        size="xs"
        label={t(`notes.agentState.${state}`)}
        variant={linkedAgentStateVariant(state)}
      />
    </Pressable>
  );
}

function LinkedAgents({ note }: { note: HostNote }): ReactElement | null {
  const { t } = useTranslation();
  const knownAgentIds = useSessionStore((state) => {
    const agents = state.sessions[note.serverId]?.agents;
    return note.linkedAgents
      .map((link) => link.agentId)
      .filter((agentId) => agents?.has(agentId))
      .join(",");
  });
  const agentIds = useMemo(() => (knownAgentIds ? knownAgentIds.split(",") : []), [knownAgentIds]);
  if (agentIds.length === 0) return null;
  return (
    <View style={styles.agents}>
      <Text style={styles.agentsLabel}>{t("notes.detail.agents")}</Text>
      {agentIds.map((agentId, index) => (
        <LinkedAgentRow key={agentId} note={note} agentId={agentId} isFirst={index === 0} />
      ))}
    </View>
  );
}

function NoteActionsMenu({
  note,
  actions,
  onDeleted,
}: {
  note: HostNote;
  actions: NoteActions;
  onDeleted: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const run = useCallback(
    (operation: () => Promise<unknown>) => {
      void operation().catch((error: unknown) => {
        toast.error(toErrorMessage(error) || t("notes.detail.saveFailed"));
      });
    },
    [t, toast],
  );
  const setTodoState = useCallback(
    (todoState: HostNote["todoState"]) => run(() => actions.update(note, { todoState })),
    [actions, note, run],
  );
  const handleMarkDone = useCallback(() => setTodoState("done"), [setTodoState]);
  const handleReopen = useCallback(() => setTodoState("open"), [setTodoState]);
  const handleMakeNote = useCallback(() => setTodoState(null), [setTodoState]);
  const handleArchive = useCallback(() => {
    run(async () => {
      await actions.setArchived(note, true);
      onDeleted();
    });
  }, [actions, note, onDeleted, run]);
  const handleDelete = useCallback(() => {
    run(async () => {
      const confirmed = await confirmDialog({
        title: t("notes.detail.deleteConfirmTitle"),
        message: t("notes.detail.deleteConfirmMessage"),
        confirmLabel: t("notes.detail.delete"),
        destructive: true,
      });
      if (!confirmed) return;
      await actions.remove(note);
      onDeleted();
    });
  }, [actions, note, onDeleted, run, t]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabStyle}
        accessibilityLabel={t("notes.detail.actions")}
        testID="note-actions-trigger"
      >
        {renderMoreIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        {note.todoState === "open" ? (
          <DropdownMenuItem leading={doneLeading} onSelect={handleMarkDone}>
            {t("notes.detail.markDone")}
          </DropdownMenuItem>
        ) : null}
        {note.todoState === "done" ? (
          <DropdownMenuItem leading={reopenLeading} onSelect={handleReopen}>
            {t("notes.detail.reopen")}
          </DropdownMenuItem>
        ) : null}
        {note.todoState === null ? (
          <DropdownMenuItem leading={todoLeading} onSelect={handleReopen}>
            {t("notes.detail.makeTodo")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem leading={noteLeading} onSelect={handleMakeNote}>
            {t("notes.detail.makeNote")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          leading={archiveLeading}
          onSelect={handleArchive}
          testID="note-menu-archive"
        >
          {t("notes.detail.archive")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          onSelect={handleDelete}
          testID="note-menu-delete"
        >
          {t("notes.detail.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function sendNoteToAgent(note: HostNote): void {
  useIncomingShareStore.getState().receive({
    text: "",
    files: [],
    droppedFileCount: 0,
    attachments: [createNoteAttachment(note.serverId, note)],
    serverId: note.serverId,
  });
}

/**
 * Edits save themselves. Each save carries the revision it was based on; when another device or an
 * agent changed the note first, the save is rejected and the editor adopts the newer version.
 */
export function NoteDetail({
  note,
  projectName,
  actions,
  onClosed,
  onRefetch,
}: {
  note: HostNote;
  projectName: string | null;
  actions: NoteActions;
  onClosed: () => void;
  onRefetch: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const [resetKey, setResetKey] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const draftRef = useRef({ title: note.title, body: note.body });
  const dirtyRef = useRef(false);
  const revisionRef = useRef(note.revision);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;

  useEffect(() => {
    if (dirtyRef.current || note.revision === revisionRef.current) return;
    revisionRef.current = note.revision;
    draftRef.current = { title: note.title, body: note.body };
    setResetKey((key) => key + 1);
  }, [note.body, note.revision, note.title]);

  const save = useCallback(async () => {
    timerRef.current = null;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setSaveState("saving");
    const draft = draftRef.current;
    try {
      const saved = await actions.update(noteRef.current, {
        title: draft.title,
        body: draft.body,
        expectedRevision: revisionRef.current,
      });
      revisionRef.current = saved.revision;
      setSaveState(dirtyRef.current ? "saving" : "saved");
    } catch (error) {
      setSaveState("idle");
      if (isNoteRevisionConflict(error)) {
        toast.error(t("notes.detail.conflict"));
        revisionRef.current = -1;
        onRefetch();
        return;
      }
      dirtyRef.current = true;
      toast.error(t("notes.detail.saveFailed"));
    }
  }, [actions, onRefetch, t, toast]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setSaveState("saving");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  }, [save]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        void save();
      }
    },
    [save],
  );

  const handleTitleChange = useCallback(
    (title: string) => {
      draftRef.current = { ...draftRef.current, title };
      scheduleSave();
    },
    [scheduleSave],
  );
  const handleBodyChange = useCallback(
    (body: string) => {
      draftRef.current = { ...draftRef.current, body };
      scheduleSave();
    },
    [scheduleSave],
  );
  const handleToggleDone = useCallback(() => {
    const todoState = note.todoState === "done" ? "open" : "done";
    void actions.update(note, { todoState }).catch((error: unknown) => {
      toast.error(toErrorMessage(error) || t("notes.detail.saveFailed"));
    });
  }, [actions, note, t, toast]);
  const handleSend = useCallback(() => sendNoteToAgent(note), [note]);

  return (
    <View style={styles.container} testID="note-detail">
      <View style={styles.toolbar}>
        <Text style={styles.saveState} numberOfLines={1}>
          {saveState === "saving" ? t("notes.detail.saving") : null}
          {saveState === "saved" ? t("notes.detail.saved") : null}
        </Text>
        <View style={styles.toolbarActions}>
          <NoteActionsMenu note={note} actions={actions} onDeleted={onClosed} />
          <Button size="sm" leftIcon={Send} onPress={handleSend} testID="note-send-to-agent">
            {t("notes.detail.sendToAgent")}
          </Button>
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.titleRow}>
          {note.todoState ? (
            <NoteTodoCheckbox note={note} onToggle={handleToggleDone} size="md" />
          ) : null}
          <AdaptiveTextInput
            initialValue={draftRef.current.title}
            resetKey={resetKey}
            onChangeText={handleTitleChange}
            placeholder={t("notes.detail.titlePlaceholder")}
            style={styles.titleInput}
            testID="note-title-input"
          />
        </View>
        <NoteMeta note={note} projectName={projectName} />
        <AdaptiveTextInput
          initialValue={draftRef.current.body}
          resetKey={resetKey}
          onChangeText={handleBodyChange}
          placeholder={t("notes.detail.bodyPlaceholder")}
          multiline
          scrollEnabled={false}
          style={styles.bodyInput}
          testID="note-body-input"
        />
        <LinkedAgents note={note} />
        {note.todoState === "open" ? (
          <View style={styles.footerActions}>
            <Button variant="outline" size="sm" leftIcon={Check} onPress={handleToggleDone}>
              {t("notes.detail.markDone")}
            </Button>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[6] },
    paddingVertical: theme.spacing[3],
  },
  saveState: {
    flex: 1,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kebab: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: theme.spacing[4],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[12] },
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[12],
    maxWidth: 820,
    width: "100%",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  titleInput: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: 0,
    borderWidth: 0,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 24,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    maxWidth: 280,
  },
  pillText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bodyInput: {
    minHeight: 160,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.6,
    paddingVertical: 0,
    paddingHorizontal: 0,
    borderWidth: 0,
    textAlignVertical: "top",
  },
  agents: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  agentsLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  agentRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  agentRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  agentTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  footerActions: {
    flexDirection: "row",
  },
}));
