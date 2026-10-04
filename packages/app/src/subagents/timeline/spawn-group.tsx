import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useProviderIcons } from "@/components/provider-icons";
import type { Theme } from "@/styles/theme";
import type { ToolCallItem } from "@/types/stream";
import { formatDuration } from "@/utils/time";
import { formatSubagentStatusCount, summarizeSubagentStatuses } from "../presentation/status";
import { useElapsedNow } from "../presentation/use-elapsed-now";
import { useSubagentTimeline } from "./context";
import { resolveSpawnGroupLiveSince, type SpawnRowModel } from "./model";
import { SpawnRowView, useSpawnRows } from "./spawn-row";

const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const CHEVRON_SIZE = 14;
const ICON_SLOT_SIZE = 22;

function GroupElapsed({ since }: { since: Date }): ReactElement {
  const now = useElapsedNow(true);
  return (
    <Text style={styles.elapsed} numberOfLines={1}>
      {formatDuration(Math.max(0, now - since.getTime()))}
    </Text>
  );
}

/**
 * Adjacent spawn calls as one expandable row: "3 subagents · 2 working · 1 done". A group that is
 * live when it first appears starts open; one that is already settled starts closed. Neither
 * moves on its own afterwards, so a child finishing never collapses the rows under the pointer.
 */
export const SubagentSpawnGroup = memo(function SubagentSpawnGroup({
  groupId,
  calls,
}: {
  groupId: string;
  calls: readonly ToolCallItem[];
}): ReactElement {
  const { t } = useTranslation();
  const { serverId, open, groupExpansion, setGroupExpanded } = useSubagentTimeline();
  const rows = useSpawnRows(calls);
  const resolveIcon = useProviderIcons(serverId);
  const [startsExpanded] = useState(() => rows.some((row) => row.status.isLive));
  const expanded = groupExpansion.get(groupId) ?? startsExpanded;
  const liveSince = resolveSpawnGroupLiveSince({ rows, calls });

  const summary = useMemo(
    () =>
      summarizeSubagentStatuses(rows.map((row) => row.status))
        .map((entry) => formatSubagentStatusCount(t, entry))
        .join(" · "),
    [rows, t],
  );
  const toggle = useCallback(() => {
    setGroupExpanded(groupId, !expanded);
  }, [expanded, groupId, setGroupExpanded]);
  const handleOpen = useCallback(
    (row: SpawnRowModel) => {
      if (row.target) open(row.target);
    },
    [open],
  );
  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.header,
      hovered || pressed ? styles.headerActive : null,
    ],
    [],
  );
  const chevronStyle = expanded ? styles.chevronExpanded : styles.chevronCollapsed;
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const countLabel = t("subagents.pillLabelMany", { count: rows.length });

  return (
    <View testID="subagent-spawn-group">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${countLabel}, ${summary}`}
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={headerStyle}
        testID="subagent-spawn-group-header"
      >
        <View style={styles.iconSlot}>
          <View style={chevronStyle}>
            <ThemedChevronRight size={CHEVRON_SIZE} uniProps={chevronColorMapping} />
          </View>
        </View>
        <Text style={styles.count} numberOfLines={1}>
          {countLabel}
        </Text>
        <Text style={styles.summary} numberOfLines={1}>
          {summary}
        </Text>
        {liveSince ? <GroupElapsed since={liveSince} /> : null}
      </Pressable>
      {expanded ? (
        <View style={styles.card}>
          {rows.map((row, index) => (
            <View key={row.key} style={index > 0 ? styles.rowDivider : null}>
              <SpawnRowView
                row={row}
                icon={resolveIcon(row.provider ?? "")}
                variant="grouped"
                onOpen={handleOpen}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: -13,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
  },
  headerActive: {
    backgroundColor: theme.colors.surface1,
  },
  iconSlot: {
    width: ICON_SLOT_SIZE,
    height: ICON_SLOT_SIZE,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[1],
  },
  chevronCollapsed: {
    transform: [{ rotate: "0deg" }],
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  count: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  summary: {
    flexShrink: 1,
    flexGrow: 1,
    minWidth: 0,
    marginLeft: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  elapsed: {
    flexShrink: 0,
    marginLeft: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  card: {
    marginTop: theme.spacing[1],
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
}));
