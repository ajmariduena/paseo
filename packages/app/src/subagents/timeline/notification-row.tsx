import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import type { SubagentNotificationEntry } from "@getpaseo/protocol/agent-types";
import { useProviderIcons, type ProviderIconComponent } from "@/components/provider-icons";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { useSessionStore } from "@/stores/session-store";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import type { Theme } from "@/styles/theme";
import { formatDuration, formatMessageTimestamp } from "@/utils/time";
import { useSubagentTimeline } from "./context";
import type { SpawnedAgentSnapshot } from "./model";
import {
  formatSubagentNotificationWord,
  resolveSubagentNotificationRows,
  type SubagentNotificationRowModel,
} from "./notification-model";

const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ROW_ICON_SIZE = 14;
// Matches the subagent row's icon slot, so the wake lines up with the rows that started it.
const ICON_SLOT_SIZE = 22;

function buildIconPresentation(input: {
  row: SubagentNotificationRowModel;
  title: string;
  icon: ProviderIconComponent;
}): WorkspaceTabPresentation {
  return {
    key: input.row.key,
    kind: "agent",
    label: input.title,
    subtitle: "",
    tooltip: input.title,
    modified: false,
    showCloseButton: false,
    titleState: "ready",
    icon: input.icon,
    statusBucket: input.row.bucket,
  };
}

interface NotificationRowViewProps {
  row: SubagentNotificationRowModel;
  icon: ProviderIconComponent;
  timestampLabel: string;
  variant: "single" | "grouped";
  onOpen: (row: SubagentNotificationRowModel) => void;
}

const NotificationRowView = memo(function NotificationRowView({
  row,
  icon,
  timestampLabel,
  variant,
  onOpen,
}: NotificationRowViewProps): ReactElement {
  const { t } = useTranslation();
  const title = row.title ?? t("subagents.untitled");
  const word = formatSubagentNotificationWord(t, row.word);
  const statusLabel =
    row.durationMs === null ? word : `${word} · ${formatDuration(row.durationMs)}`;
  const handlePress = useCallback(() => onOpen(row), [onOpen, row]);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => {
      const isActive = hovered || pressed;
      if (variant === "single") {
        return [styles.singleRow, isActive ? styles.singleRowActive : null];
      }
      return [styles.groupedRow, isActive ? styles.groupedRowActive : null];
    },
    [variant],
  );
  const presentation = useMemo(
    () => buildIconPresentation({ row, title, icon }),
    [icon, row, title],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("subagents.openAction", { label: title })}
      onPress={handlePress}
      style={pressableStyle}
      testID={`subagent-notification-row-${row.key}`}
    >
      {({ hovered, pressed }: PressableStateCallbackType) => (
        <>
          <View style={styles.headline}>
            <View style={styles.iconSlot}>
              <WorkspaceTabIcon
                presentation={presentation}
                size={ROW_ICON_SIZE}
                backdrop={variantBackdrop(variant, hovered || pressed)}
              />
            </View>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Text
              style={row.word === "failed" ? styles.statusFailed : styles.status}
              numberOfLines={1}
            >
              {statusLabel}
            </Text>
            <Text style={styles.timestamp} numberOfLines={1}>
              {timestampLabel}
            </Text>
            <ThemedChevronRight size={ROW_ICON_SIZE} uniProps={chevronColorMapping} />
          </View>
          {row.modelLabel ? (
            <Text style={styles.modelLabel} numberOfLines={1}>
              {row.modelLabel}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
});

function variantBackdrop(variant: "single" | "grouped", isActive: boolean): SurfaceBackdrop {
  if (variant === "single") return isActive ? "surface1" : "surface0";
  return isActive ? "surface2" : "surface1";
}

/**
 * A wake drawn as the rows of the children it reports on: the dot and word are the reported
 * event, the trailing slot is when it arrived. A wake for several children holds their rows in
 * one card, as an open subagent group does.
 */
export const SubagentNotificationRows = memo(function SubagentNotificationRows({
  notificationId,
  entries,
  timestamp,
}: {
  notificationId: string;
  entries: readonly SubagentNotificationEntry[];
  timestamp: Date;
}): ReactElement {
  const { serverId, providerEntries, open } = useSubagentTimeline();
  const resolveIcon = useProviderIcons(serverId);
  const agents = useSessionStore(
    useShallow((state): (SpawnedAgentSnapshot | null)[] => {
      const session = state.sessions[serverId];
      return entries.map(
        (entry) =>
          session?.agents.get(entry.agentId) ?? session?.agentDetails.get(entry.agentId) ?? null,
      );
    }),
  );
  const rows = useMemo(
    () => resolveSubagentNotificationRows({ notificationId, entries, agents, providerEntries }),
    [agents, entries, notificationId, providerEntries],
  );
  const timestampLabel = useMemo(() => formatMessageTimestamp(timestamp), [timestamp]);
  const handleOpen = useCallback((row: SubagentNotificationRowModel) => open(row.target), [open]);

  if (rows.length === 1 && rows[0]) {
    return (
      <View testID="subagent-notification">
        <NotificationRowView
          row={rows[0]}
          icon={resolveIcon(rows[0].provider ?? "")}
          timestampLabel={timestampLabel}
          variant="single"
          onOpen={handleOpen}
        />
      </View>
    );
  }
  return (
    <View style={styles.card} testID="subagent-notification">
      {rows.map((row, index) => (
        <View key={row.key} style={index > 0 ? styles.rowDivider : null}>
          <NotificationRowView
            row={row}
            icon={resolveIcon(row.provider ?? "")}
            timestampLabel={timestampLabel}
            variant="grouped"
            onOpen={handleOpen}
          />
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  singleRow: {
    marginHorizontal: -13,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
  },
  singleRowActive: {
    backgroundColor: theme.colors.surface1,
  },
  groupedRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  groupedRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  card: {
    marginHorizontal: -13,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  rowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  headline: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: ICON_SLOT_SIZE,
  },
  iconSlot: {
    width: ICON_SLOT_SIZE,
    height: ICON_SLOT_SIZE,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[1],
  },
  title: {
    flexShrink: 1,
    flexGrow: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  status: {
    flexShrink: 0,
    marginLeft: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  statusFailed: {
    flexShrink: 0,
    marginLeft: theme.spacing[2],
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  timestamp: {
    flexShrink: 0,
    marginLeft: theme.spacing[2],
    marginRight: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  modelLabel: {
    paddingLeft: ICON_SLOT_SIZE + theme.spacing[1],
    paddingTop: theme.spacing[0.5],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
