import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { Square } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentBackgroundTask } from "@getpaseo/protocol/agent-types";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

const ThemedSquare = withUnistyles(Square);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ROW_ICON_SIZE = 12;

export const AgentBackgroundTasksTrack = memo(function AgentBackgroundTasksTrack({
  serverId,
  agentId,
  tasks,
}: {
  serverId: string;
  agentId: string;
  tasks: readonly AgentBackgroundTask[] | undefined;
}): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const count = tasks?.length ?? 0;
  const label = t("backgroundTasks.pillLabel", { count });
  const segments = useMemo(() => [{ bucket: "running" as const, text: label }], [label]);
  const handleStop = useCallback(
    (taskId: string) => {
      const client = useSessionStore.getState().sessions[serverId]?.client;
      if (!client) {
        toast.error(i18n.t("workspaceSetup.errors.hostDisconnected"));
        return;
      }
      client.stopAgentBackgroundTask(agentId, taskId).catch((error: unknown) => {
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, serverId, toast],
  );

  if (!tasks?.length) return null;

  return (
    <ComposerTrackPill
      testID="background-tasks-track-header"
      segments={segments}
      panelTitle={t("backgroundTasks.title")}
    >
      {tasks.map((task) => (
        <BackgroundTaskRow key={task.id} task={task} onStop={handleStop} />
      ))}
    </ComposerTrackPill>
  );
});

function BackgroundTaskRow({
  task,
  onStop,
}: {
  task: AgentBackgroundTask;
  onStop: (taskId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const startedAt = useMemo(() => new Date(task.startedAt), [task.startedAt]);
  const elapsed = useCompactTimeAgo(startedAt);
  const label = task.description || task.taskType;
  const handleStop = useCallback(() => onStop(task.id), [onStop, task.id]);

  return (
    <ComposerTrackRow accessibilityLabel={label} testID={`background-tasks-track-row-${task.id}`}>
      <>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.rowTrailing} numberOfLines={1}>
          {elapsed}
        </Text>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("backgroundTasks.stopAction", { label })}
              testID={`background-tasks-track-stop-${task.id}`}
              onPress={handleStop}
              style={styles.actionButton}
              hitSlop={8}
            >
              {({ hovered, pressed }) => (
                <ThemedSquare
                  size={ROW_ICON_SIZE}
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
                />
              )}
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{t("backgroundTasks.stopTooltip")}</Text>
          </TooltipContent>
        </Tooltip>
      </>
    </ComposerTrackRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowTrailing: {
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
