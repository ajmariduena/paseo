import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowDown, ArrowUp, MoreVertical, Pencil, Trash2 } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useSessionStore } from "@/stores/session-store";
import { formatSentByLabel } from "@/subagents/timeline/message-sender";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  resolveEditableQueueText,
  resolveQueueEntryMoves,
  resolveQueueEntrySource,
  type ServerQueueEntry,
} from "./model";
import {
  IDLE_QUEUE_ACTION,
  type QueueActionState,
  type RunQueueAction,
  type ServerQueueActions,
} from "./actions";
import { forgetQueuedText, readQueuedText, rememberQueuedText } from "./queued-text";

function actionStateForEntry(state: QueueActionState, entryId: string): QueueActionState {
  if (state.status === "idle" || state.entryId !== entryId) return IDLE_QUEUE_ACTION;
  return state;
}

/** The daemon's queue for one agent, above the composer input. */
export const ServerQueueTrack = memo(function ServerQueueTrack({
  serverId,
  agentId,
  actions,
}: {
  serverId: string;
  agentId: string;
  actions: ServerQueueActions;
}): ReactElement | null {
  const queue = useSessionStore((state) => state.sessions[serverId]?.agents.get(agentId)?.queue);

  const entries = queue?.entries;
  if (!entries?.length) return null;
  const isBusy = actions.state.status === "pending";

  return (
    <View style={styles.track} testID="server-queue-track">
      {entries.map((entry) => (
        <ServerQueueRow
          key={entry.id}
          serverId={serverId}
          agentId={agentId}
          entry={entry}
          entries={entries}
          actionState={actionStateForEntry(actions.state, entry.id)}
          isTrackBusy={isBusy}
          runAction={actions.run}
          sendNow={actions.sendNow}
        />
      ))}
    </View>
  );
});

interface ServerQueueRowProps {
  serverId: string;
  agentId: string;
  entry: ServerQueueEntry;
  entries: readonly ServerQueueEntry[];
  actionState: QueueActionState;
  isTrackBusy: boolean;
  runAction: RunQueueAction;
  sendNow: (entryId: string) => void;
}

function ServerQueueRow({
  serverId,
  agentId,
  entry,
  entries,
  actionState,
  isTrackBusy,
  runAction,
  sendNow,
}: ServerQueueRowProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const editableText = resolveEditableQueueText(entry, readQueuedText(entry.id));
  const moves = useMemo(() => resolveQueueEntryMoves(entries, entry.id), [entries, entry.id]);
  const meta = useQueueEntryMeta(serverId, entry);
  const isPending = actionState.status === "pending";

  const handleStartEdit = useCallback(() => setDraft(editableText), [editableText]);
  const handleCancelEdit = useCallback(() => setDraft(null), []);
  const handleSaveEdit = useCallback(() => {
    if (draft === null) return;
    const text = draft.trim();
    void runAction(entry.id, "edit", async (client) => {
      await client.editQueuedAgentMessage(agentId, entry.id, text);
      rememberQueuedText(entry.id, text);
      setDraft(null);
    });
  }, [agentId, draft, entry.id, runAction]);

  const handleSendNow = useCallback(() => sendNow(entry.id), [entry.id, sendNow]);

  const handleMove = useCallback(
    (order: string[]) => {
      void runAction(entry.id, "move", (client) => client.reorderAgentQueue(agentId, order));
    },
    [agentId, entry.id, runAction],
  );
  const handleMoveUp = useCallback(() => {
    if (moves.up) handleMove(moves.up);
  }, [handleMove, moves.up]);
  const handleMoveDown = useCallback(() => {
    if (moves.down) handleMove(moves.down);
  }, [handleMove, moves.down]);

  const handleRemove = useCallback(async () => {
    const isSubagentResults = entry.origin === "delegation_wake";
    const messageKey = isSubagentResults
      ? "composer.queue.removeResultsConfirmMessage"
      : "composer.queue.removeConfirmMessage";
    const confirmed = await confirmDialog({
      title: t("composer.queue.removeConfirmTitle"),
      message: t(messageKey),
      confirmLabel: t("composer.queue.remove"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    await runAction(entry.id, "remove", async (client) => {
      await client.cancelQueuedAgentMessage(agentId, entry.id);
      forgetQueuedText(entry.id);
    });
  }, [agentId, entry.id, entry.origin, runAction, t]);
  const handleRemovePress = useCallback(() => {
    void handleRemove();
  }, [handleRemove]);

  const isEditing = draft !== null;
  const trimmedDraft = draft?.trim() ?? "";
  const isChanged = trimmedDraft !== editableText?.trim();
  const leavesContent = trimmedDraft.length > 0 || entry.attachmentCount > 0;
  const canSave = isEditing && isChanged && leavesContent;

  return (
    <View>
      <View style={styles.row} testID={`server-queue-row-${entry.id}`}>
        <View style={styles.content}>
          {meta ? (
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
          {isEditing ? (
            <FormTextInput
              size="sm"
              multiline
              autoFocus
              initialValue={draft}
              onChangeText={setDraft}
              editable={!isPending}
              accessibilityLabel={t("composer.queue.editFieldLabel")}
              testID={`server-queue-edit-${entry.id}`}
            />
          ) : (
            <Text style={styles.text} numberOfLines={2} ellipsizeMode="tail">
              {entry.textPreview}
            </Text>
          )}
        </View>
        {isEditing ? (
          <View style={styles.actions}>
            <Button variant="ghost" size="xs" onPress={handleCancelEdit} disabled={isPending}>
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onPress={handleSaveEdit}
              disabled={!canSave || isTrackBusy}
              loading={isPending}
              testID={`server-queue-save-${entry.id}`}
            >
              {t("composer.queue.save")}
            </Button>
          </View>
        ) : (
          <ServerQueueRowActions
            entryId={entry.id}
            isPending={isPending}
            isDisabled={isTrackBusy}
            canEdit={editableText !== null}
            canMoveUp={moves.up !== null}
            canMoveDown={moves.down !== null}
            onEdit={handleStartEdit}
            onSendNow={handleSendNow}
            onMoveUp={handleMoveUp}
            onMoveDown={handleMoveDown}
            onRemove={handleRemovePress}
          />
        )}
      </View>
      {actionState.status === "failed" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t(`composer.queue.errors.${actionState.action}`, { message: actionState.message })}
        </Text>
      ) : null}
    </View>
  );
}

function useQueueEntryMeta(serverId: string, entry: ServerQueueEntry): string | null {
  const { t } = useTranslation();
  const source = resolveQueueEntrySource(entry);
  const senderAgentId = source.kind === "agent" ? source.senderAgentId : null;
  const senderTitle = useSessionStore((state) => {
    if (!senderAgentId) return undefined;
    const session = state.sessions[serverId];
    return (session?.agents.get(senderAgentId) ?? session?.agentDetails.get(senderAgentId))?.title;
  });
  const parts: string[] = [];
  if (source.kind === "agent") parts.push(formatSentByLabel(t, senderTitle));
  if (source.kind === "subagent_results") parts.push(t("composer.queue.subagentResults"));
  if (source.kind === "notification") parts.push(t("composer.queue.notification"));
  if (entry.attachmentCount > 0) {
    parts.push(t("composer.queue.attachmentCount", { count: entry.attachmentCount }));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

interface ServerQueueRowActionsProps {
  entryId: string;
  isPending: boolean;
  isDisabled: boolean;
  canEdit: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: () => void;
  onSendNow: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function ServerQueueRowActions({
  entryId,
  isPending,
  isDisabled,
  canEdit,
  canMoveUp,
  canMoveDown,
  onEdit,
  onSendNow,
  onMoveUp,
  onMoveDown,
  onRemove,
}: ServerQueueRowActionsProps): ReactElement {
  const { t } = useTranslation();
  if (isPending) {
    return (
      <View style={styles.actions}>
        <View style={styles.actionButton}>
          <ThemedSpinner uniProps={mutedColorMapping} />
        </View>
      </View>
    );
  }
  const actionStyle = isDisabled ? styles.disabled : undefined;
  return (
    <View style={[styles.actions, actionStyle]}>
      {canEdit ? (
        <Pressable
          onPress={onEdit}
          disabled={isDisabled}
          style={styles.actionButton}
          accessibilityLabel={t("composer.attachments.editQueuedMessage")}
          accessibilityRole="button"
          testID={`server-queue-edit-button-${entryId}`}
        >
          <ThemedPencil size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />
        </Pressable>
      ) : null}
      <Pressable
        onPress={onSendNow}
        disabled={isDisabled}
        style={[styles.actionButton, styles.sendButton]}
        accessibilityLabel={t("composer.attachments.sendQueuedMessageNow")}
        accessibilityRole="button"
        testID={`server-queue-send-now-${entryId}`}
      >
        <ThemedArrowUp size={ICON_SIZE.sm} uniProps={accentForegroundColorMapping} />
      </Pressable>
      <DropdownMenu>
        <DropdownMenuTrigger
          hitSlop={8}
          disabled={isDisabled}
          style={kebabTriggerStyle}
          accessibilityRole="button"
          accessibilityLabel={t("composer.queue.actionsLabel")}
          testID={`server-queue-menu-${entryId}`}
        >
          {renderKebabIcon}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" width={200}>
          {canMoveUp ? (
            <DropdownMenuItem leading={moveUpLeading} onSelect={onMoveUp}>
              {t("composer.queue.moveUp")}
            </DropdownMenuItem>
          ) : null}
          {canMoveDown ? (
            <DropdownMenuItem leading={moveDownLeading} onSelect={onMoveDown}>
              {t("composer.queue.moveDown")}
            </DropdownMenuItem>
          ) : null}
          {canMoveUp || canMoveDown ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            leading={removeLeading}
            destructive
            onSelect={onRemove}
            testID={`server-queue-remove-${entryId}`}
          >
            {t("composer.queue.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function renderKebabIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={ICON_SIZE.sm}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

const ThemedPencil = withUnistyles(Pencil);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedTrash = withUnistyles(Trash2);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentForegroundColorMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

const moveUpLeading = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownLeading = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeLeading = <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

const styles = StyleSheet.create((theme: Theme) => ({
  track: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  content: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  actionButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  sendButton: {
    backgroundColor: theme.colors.accent,
  },
  kebabTrigger: {
    padding: 2,
    borderRadius: 4,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
}));
