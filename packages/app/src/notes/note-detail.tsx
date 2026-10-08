import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import Animated from "react-native-reanimated";
import { Archive, Mic, MoreHorizontal, Send, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { DictationOverlay } from "@/components/dictation-controls";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  iconButtonChromeFrameStyle,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { useControlDensity } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { useDictation } from "@/hooks/use-dictation";
import { useIncomingShareStore } from "@/incoming-share/store";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { createNoteAttachment } from "./attachment";
import { isNoteRevisionConflict, type HostNote, type NoteActions } from "./data";
import { EditorAccessoryRow } from "./editor-accessory-row";
import {
  appendTranscript,
  foldTitleIntoBody,
  isBlankNoteText,
  linkedAgentStateVariant,
  resolveLinkedAgentState,
  toggleChecklistLine,
  type TextEdit,
} from "./model";
import { useChecklistKeys } from "./use-checklist-keys";

const AUTOSAVE_DELAY_MS = 600;
const MENU_ICON_SIZE = 14;
const TOOLBAR_ICON_SIZE = 16;

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedMic = withUnistyles(Mic);
const ThemedSend = withUnistyles(Send);
const ThemedArchive = withUnistyles(Archive);
const ThemedTrash = withUnistyles(Trash2);

const archiveLeading = <ThemedArchive size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

type SaveState = "idle" | "saving" | "saved";

function iconColor(hovered: boolean | undefined) {
  return hovered ? foregroundColorMapping : mutedColorMapping;
}

function renderMoreIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return <ThemedMore size={TOOLBAR_ICON_SIZE} uniProps={iconColor(hovered)} />;
}

function renderMicIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return <ThemedMic size={TOOLBAR_ICON_SIZE} uniProps={iconColor(hovered)} />;
}

function renderSendIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return <ThemedSend size={TOOLBAR_ICON_SIZE} uniProps={iconColor(hovered)} />;
}

function toolbarIconStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.toolbarIcon, hovered && styles.toolbarIconHovered];
}

function useHeaderIconStyle() {
  const density = useControlDensity();
  return useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) =>
      iconButtonChromeStyle({
        size: "large",
        state: { hovered: Boolean(hovered), pressed },
        density,
      }),
    [density],
  );
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
  compact,
  onDeleted,
}: {
  note: HostNote;
  actions: NoteActions;
  compact: boolean;
  onDeleted: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const headerIconStyle = useHeaderIconStyle();
  const run = useCallback(
    (operation: () => Promise<unknown>) => {
      void operation().catch((error: unknown) => {
        toast.error(toErrorMessage(error) || t("notes.detail.saveFailed"));
      });
    },
    [t, toast],
  );
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
        hitSlop={compact ? undefined : 8}
        style={compact ? headerIconStyle : toolbarIconStyle}
        accessibilityLabel={t("notes.detail.actions")}
        testID="note-actions-trigger"
      >
        {renderMoreIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
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

function useNoteDictation(serverId: string, onTranscript: (transcript: string) => void) {
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const handleError = useCallback((error: Error) => toast.error(error.message), [toast]);
  const canUseDictation = useCallback(() => client?.isConnected ?? false, [client]);
  const dictation = useDictation({
    client,
    onTranscript,
    onError: handleError,
    canStart: canUseDictation,
    canConfirm: canUseDictation,
  });
  const active = dictation.isRecording || dictation.isProcessing || dictation.status !== "idle";
  return { dictation, active };
}

/**
 * Edits save themselves. `note` is null for a draft: nothing reaches the host until the first
 * non-blank keystroke creates the note. Each save carries the revision it was based on; when
 * another device or an agent changed the note first, the save is rejected and the editor adopts
 * the newer version. Leaving a note whose text was emptied deletes it.
 */
export function NoteDetail({
  note,
  serverId,
  actions,
  compact,
  autoFocus,
  onCreated,
  onClosed,
  onRefetch,
}: {
  note: HostNote | null;
  serverId: string;
  actions: NoteActions;
  compact: boolean;
  autoFocus: boolean;
  onCreated: (note: HostNote) => void;
  onClosed: () => void;
  onRefetch: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [target, setTarget] = useState<HostNote | null>(note);
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const initialTextRef = useRef(note ? foldTitleIntoBody(note) : "");
  const textRef = useRef(initialTextRef.current);
  const targetRef = useRef<HostNote | null>(note);
  const revisionRef = useRef(note?.revision ?? -1);
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const creatingRef = useRef(false);
  const closedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!note) return;
    targetRef.current = note;
    setTarget(note);
    if (dirtyRef.current || inFlightRef.current || note.revision <= revisionRef.current) return;
    revisionRef.current = note.revision;
    textRef.current = foldTitleIntoBody(note);
    inputRef.current?.replaceText(textRef.current);
  }, [note]);

  const save = useCallback(async () => {
    timerRef.current = null;
    const current = targetRef.current;
    if (!dirtyRef.current || !current) return;
    dirtyRef.current = false;
    inFlightRef.current = true;
    setSaveState("saving");
    try {
      const saved = await actions.update(current, {
        title: "",
        body: textRef.current,
        expectedRevision: revisionRef.current,
      });
      revisionRef.current = saved.revision;
      targetRef.current = saved;
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
    } finally {
      inFlightRef.current = false;
    }
  }, [actions, onRefetch, t, toast]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setSaveState("saving");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  }, [save]);

  const createFromDraft = useCallback(() => {
    if (creatingRef.current || isBlankNoteText(textRef.current)) return;
    creatingRef.current = true;
    setSaveState("saving");
    const body = textRef.current;
    void (async () => {
      try {
        const created = await actions.create(serverId, { title: "", body });
        targetRef.current = created;
        revisionRef.current = created.revision;
        setTarget(created);
        onCreated(created);
        if (textRef.current !== body) scheduleSave();
        else setSaveState("saved");
      } catch (error) {
        setSaveState("idle");
        toast.error(toErrorMessage(error) || t("notes.detail.saveFailed"));
      } finally {
        creatingRef.current = false;
      }
    })();
  }, [actions, onCreated, scheduleSave, serverId, t, toast]);

  const commitText = useCallback(
    (text: string) => {
      textRef.current = text;
      if (targetRef.current) scheduleSave();
      else createFromDraft();
    },
    [createFromDraft, scheduleSave],
  );

  const applyEdit = useCallback(
    (edit: TextEdit) => {
      inputRef.current?.replaceText(edit.text, edit.selection);
      commitText(edit.text);
    },
    [commitText],
  );
  const getInput = useCallback(() => inputRef.current?.getNativeRef() ?? null, []);
  const checklist = useChecklistKeys({ applyEdit, getInput });

  const handleChangeText = useCallback(
    (next: string) => {
      const edit = checklist.interceptChange(textRef.current, next);
      if (edit) applyEdit(edit);
      else commitText(next);
    },
    [applyEdit, checklist, commitText],
  );

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      const current = targetRef.current;
      if (closedRef.current || !current) return;
      if (isBlankNoteText(textRef.current)) {
        if (timerRef.current) clearTimeout(timerRef.current);
        void actions.remove(current).catch(() => undefined);
        return;
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        void saveRef.current();
      }
    },
    [actions],
  );

  const handleTranscript = useCallback(
    (transcript: string) => {
      const text = appendTranscript(textRef.current, transcript);
      applyEdit({ text, selection: { start: text.length, end: text.length } });
    },
    [applyEdit],
  );
  const { dictation, active: dictationActive } = useNoteDictation(serverId, handleTranscript);
  const handleDictate = useCallback(() => void dictation.startDictation(), [dictation]);

  const handleChecklist = useCallback(() => {
    applyEdit(toggleChecklistLine(textRef.current, checklist.getSelection()));
    inputRef.current?.focus();
  }, [applyEdit, checklist]);
  const handleDone = useCallback(() => inputRef.current?.blur(), []);

  const handleSend = useCallback(() => {
    void (async () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        await save();
      }
      if (targetRef.current) sendNoteToAgent(targetRef.current);
    })();
  }, [save]);
  const handleDeleted = useCallback(() => {
    closedRef.current = true;
    onClosed();
  }, [onClosed]);

  const headerIconStyle = useHeaderIconStyle();
  const { style: keyboardPaddingStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: compact,
  });

  const menu = useMemo(
    () =>
      target ? (
        <NoteActionsMenu
          note={target}
          actions={actions}
          compact={compact}
          onDeleted={handleDeleted}
        />
      ) : (
        <View
          style={[
            compact ? iconButtonChromeFrameStyle("large") : styles.toolbarIcon,
            styles.toolbarIconDisabled,
          ]}
        >
          <ThemedMore size={TOOLBAR_ICON_SIZE} uniProps={mutedColorMapping} />
        </View>
      ),
    [actions, compact, handleDeleted, target],
  );

  const compactHeaderActions = useMemo(
    () => (
      <View style={styles.headerActions}>
        <Pressable
          onPress={handleSend}
          disabled={!target}
          style={headerIconStyle}
          accessibilityRole="button"
          accessibilityLabel={t("notes.detail.sendToAgent")}
          testID="note-send-to-agent"
        >
          {renderSendIcon}
        </Pressable>
        {menu}
      </View>
    ),
    [handleSend, headerIconStyle, menu, t, target],
  );

  const dictationOverlay = dictationActive ? (
    <View style={styles.dictation}>
      <DictationOverlay
        volume={dictation.volume}
        isRecording={dictation.isRecording}
        isProcessing={dictation.isProcessing}
        status={dictation.status}
        errorText={dictation.status === "failed" ? (dictation.error ?? undefined) : undefined}
        onCancel={dictation.cancelDictation}
        onAccept={dictation.confirmDictation}
        onAcceptAndSend={dictation.confirmDictation}
        onRetry={dictation.status === "failed" ? dictation.retryFailedDictation : undefined}
        onDiscard={dictation.status === "failed" ? dictation.discardFailedDictation : undefined}
      />
    </View>
  ) : null;

  const editor = (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <AdaptiveTextInput
        ref={inputRef}
        initialValue={initialTextRef.current}
        onChangeText={handleChangeText}
        placeholder={t("notes.detail.bodyPlaceholder")}
        multiline
        scrollEnabled={false}
        autoFocus={autoFocus}
        style={styles.bodyInput}
        testID="note-body-input"
        {...checklist.inputProps}
      />
      {target ? <LinkedAgents note={target} /> : null}
    </ScrollView>
  );

  if (compact) {
    return (
      <Animated.View style={[styles.container, keyboardPaddingStyle]} testID="note-detail">
        <BackHeader
          title={t("notes.detail.back")}
          onBack={onClosed}
          rightContent={compactHeaderActions}
        />
        {editor}
        {dictationOverlay}
        <EditorAccessoryRow
          onChecklist={handleChecklist}
          onDictate={handleDictate}
          onDone={handleDone}
          dictationActive={dictationActive}
        />
      </Animated.View>
    );
  }

  return (
    <View style={styles.container} testID="note-detail">
      <View style={styles.toolbar}>
        <Text style={styles.saveState} numberOfLines={1}>
          {saveState === "saving" ? t("notes.detail.saving") : null}
          {saveState === "saved" ? t("notes.detail.saved") : null}
        </Text>
        <View style={styles.toolbarActions}>
          <Pressable
            onPress={handleDictate}
            disabled={dictationActive}
            hitSlop={8}
            style={toolbarIconStyle}
            accessibilityRole="button"
            accessibilityLabel={t("notes.detail.dictate")}
            testID="note-dictate"
          >
            {renderMicIcon}
          </Pressable>
          {menu}
          <Button
            size="sm"
            leftIcon={Send}
            onPress={handleSend}
            disabled={!target}
            testID="note-send-to-agent"
          >
            {t("notes.detail.sendToAgent")}
          </Button>
        </View>
      </View>
      {editor}
      {dictationOverlay}
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
    paddingLeft: theme.spacing[12],
    paddingRight: theme.spacing[6],
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
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  toolbarIcon: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  toolbarIconDisabled: {
    opacity: theme.opacity[50],
  },
  toolbarIconHovered: {
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
  bodyInput: {
    minHeight: 160,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.6,
    paddingVertical: 0,
    paddingHorizontal: 0,
    borderWidth: 0,
    // The editor is the whole pane; a focus ring around it reads as a form field.
    outlineWidth: 0,
    textAlignVertical: "top",
  },
  dictation: {
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
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
}));
