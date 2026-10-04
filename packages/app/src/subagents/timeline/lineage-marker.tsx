import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight, CornerLeftUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import { LineageMenuSurface } from "@/lineage/sheet";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { resolveRowLabel } from "../track-presentation";
import { useOpenSubagent } from "../use-open-subagent";

const ThemedCornerLeftUp = withUnistyles(CornerLeftUp);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ICON_SIZE = 14;

/**
 * "Subagent of {parent}" at the head of a subagent's timeline. It is the first stream row, so it
 * scrolls away with history and costs no chrome; pressing it opens the agent's lineage.
 */
export function LineageMarker({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string | undefined;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const { tabId, openTab } = usePaneContext();
  const actions = useOpenSubagent({ serverId, workspaceId, parentTabId: tabId, openTab });
  const parentId = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.parentAgentId;
  });
  const parentTitle = useSessionStore((state) => {
    if (!parentId) return null;
    const session = state.sessions[serverId];
    return (session?.agents.get(parentId) ?? session?.agentDetails.get(parentId))?.title ?? null;
  });
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.marker,
      hovered || pressed || open ? styles.markerActive : null,
    ],
    [],
  );
  if (!parentId) return null;
  const label = t("lineage.subagentOf", {
    title: resolveRowLabel(parentTitle) ?? t("lineage.parentFallback"),
  });

  return (
    <View style={styles.rail}>
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel={label}
          style={triggerStyle}
          testID="lineage-marker"
        >
          <ThemedCornerLeftUp size={ICON_SIZE} uniProps={mutedColorMapping} />
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
          <ThemedChevronRight size={ICON_SIZE} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <LineageMenuSurface serverId={serverId} agentId={agentId} actions={actions} />
      </DropdownMenu>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[2],
  },
  marker: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    height: 28,
    maxWidth: "100%",
    marginHorizontal: -13,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  markerActive: {
    backgroundColor: theme.colors.surface1,
  },
  label: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
