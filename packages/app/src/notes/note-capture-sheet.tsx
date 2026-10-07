import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, Mic, Send } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { DictationOverlay } from "@/components/dictation-controls";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-api-context";
import { useDictation } from "@/hooks/use-dictation";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import type { NoteActions } from "./data";
import { sendNoteToAgent } from "./note-detail";

export interface NoteProjectOption {
  projectId: string;
  label: string;
}

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedMic = withUnistyles(Mic);
const ThemedChevronDown = withUnistyles(ChevronDown);

type SaveMode = "save" | "send";

function appendTranscript(current: string, transcript: string): string {
  const addition = transcript.trim();
  if (!addition) return current;
  if (!current.trim()) return addition;
  return /\s$/.test(current) ? `${current}${addition}` : `${current} ${addition}`;
}

function projectTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.projectTrigger, hovered && styles.projectTriggerHovered];
}

function micStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.mic, (hovered || pressed) && styles.micHovered];
}

function ProjectMenuItem({
  projectId,
  label,
  onChange,
}: {
  projectId: string | null;
  label: string;
  onChange: (projectId: string | null) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onChange(projectId), [onChange, projectId]);
  return <DropdownMenuItem onSelect={handleSelect}>{label}</DropdownMenuItem>;
}

function ProjectPicker({
  options,
  value,
  onChange,
}: {
  options: readonly NoteProjectOption[];
  value: string | null;
  onChange: (projectId: string | null) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const label = options.find((option) => option.projectId === value)?.label ?? t("notes.noProject");
  if (options.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={projectTriggerStyle}
        accessibilityLabel={t("notes.capture.project")}
        testID="note-capture-project"
      >
        <Text style={styles.projectLabel} numberOfLines={1}>
          {label}
        </Text>
        <ThemedChevronDown size={12} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={240}>
        <ProjectMenuItem projectId={null} label={t("notes.noProject")} onChange={onChange} />
        {options.map((option) => (
          <ProjectMenuItem
            key={option.projectId}
            projectId={option.projectId}
            label={option.label}
            onChange={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function NoteCaptureSheet({
  visible,
  serverId,
  projectOptions,
  defaultProjectId,
  defaultTodo,
  actions,
  onClose,
  onCreated,
}: {
  visible: boolean;
  serverId: string;
  projectOptions: readonly NoteProjectOption[];
  defaultProjectId: string | null;
  defaultTodo: boolean;
  actions: NoteActions;
  onClose: () => void;
  onCreated: (noteId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const bodyRef = useRef("");
  const [resetKey, setResetKey] = useState(0);
  const [hasText, setHasText] = useState(false);
  const [todo, setTodo] = useState(defaultTodo);
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId);
  const [saving, setSaving] = useState<SaveMode | null>(null);

  const handleChange = useCallback((text: string) => {
    bodyRef.current = text;
    setHasText(text.trim().length > 0);
  }, []);

  const handleTranscript = useCallback((transcript: string) => {
    bodyRef.current = appendTranscript(bodyRef.current, transcript);
    setHasText(bodyRef.current.trim().length > 0);
    setResetKey((key) => key + 1);
  }, []);
  const handleDictationError = useCallback(
    (error: Error) => {
      toast.error(error.message);
    },
    [toast],
  );
  const canUseDictation = useCallback(() => client?.isConnected ?? false, [client]);
  const dictation = useDictation({
    client,
    onTranscript: handleTranscript,
    onError: handleDictationError,
    canStart: canUseDictation,
    canConfirm: canUseDictation,
  });
  const dictationActive =
    dictation.isRecording || dictation.isProcessing || dictation.status !== "idle";

  const reset = useCallback(() => {
    bodyRef.current = "";
    setHasText(false);
    setResetKey((key) => key + 1);
  }, []);

  const handleClose = useCallback(() => {
    if (saving) return;
    void dictation.cancelDictation();
    reset();
    onClose();
  }, [dictation, onClose, reset, saving]);

  const submit = useStableEvent(async (mode: SaveMode) => {
    const body = bodyRef.current;
    if (!body.trim() || saving) return;
    setSaving(mode);
    try {
      const note = await actions.create(serverId, { title: "", body, todo, projectId });
      reset();
      onClose();
      onCreated(note.id);
      if (mode === "send") sendNoteToAgent(note);
    } catch (error) {
      toast.error(toErrorMessage(error) || t("notes.detail.saveFailed"));
    } finally {
      setSaving(null);
    }
  });
  const handleSave = useCallback(() => void submit("save"), [submit]);
  const handleSaveAndSend = useCallback(() => void submit("send"), [submit]);
  const handleStartDictation = useCallback(() => void dictation.startDictation(), [dictation]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("notes.capture.title"),
      actions: <ProjectPicker options={projectOptions} value={projectId} onChange={setProjectId} />,
    }),
    [projectId, projectOptions, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={handleClose}
      header={header}
      desktopMaxWidth={560}
      testID="note-capture-sheet"
    >
      <View style={styles.body}>
        <AdaptiveTextInput
          initialValue={bodyRef.current}
          resetKey={resetKey}
          onChangeText={handleChange}
          placeholder={t("notes.capture.placeholder")}
          multiline
          autoFocus
          style={styles.input}
          testID="note-capture-input"
        />
        {dictationActive ? (
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
              onDiscard={
                dictation.status === "failed" ? dictation.discardFailedDictation : undefined
              }
            />
          </View>
        ) : (
          <View style={styles.options}>
            <View style={styles.todoToggle}>
              <Switch
                value={todo}
                onValueChange={setTodo}
                accessibilityLabel={t("notes.capture.todo")}
                testID="note-capture-todo"
              />
              <Text style={styles.todoLabel}>{t("notes.capture.todo")}</Text>
            </View>
            <Pressable
              onPress={handleStartDictation}
              style={micStyle}
              accessibilityRole="button"
              accessibilityLabel={t("notes.capture.dictate")}
              testID="note-capture-dictate"
            >
              <ThemedMic size={18} uniProps={mutedColorMapping} />
            </Pressable>
          </View>
        )}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={handleSave}
            disabled={!hasText || saving !== null || dictationActive}
            testID="note-capture-save"
          >
            {saving === "save" ? t("notes.capture.saving") : t("notes.capture.save")}
          </Button>
          <Button
            style={styles.actionButton}
            leftIcon={Send}
            onPress={handleSaveAndSend}
            disabled={!hasText || saving !== null || dictationActive}
            testID="note-capture-save-send"
          >
            {saving === "send" ? t("notes.capture.saving") : t("notes.capture.saveAndSend")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  input: {
    minHeight: 120,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.content,
    textAlignVertical: "top",
  },
  dictation: {
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  options: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  todoToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  todoLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  mic: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  micHovered: {
    backgroundColor: theme.colors.surface3,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
  projectTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 26,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    maxWidth: 200,
  },
  projectTriggerHovered: {
    backgroundColor: theme.colors.surface3,
  },
  projectLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
