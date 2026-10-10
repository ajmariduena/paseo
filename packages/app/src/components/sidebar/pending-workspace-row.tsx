import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { StatusRing } from "@/components/status-ring";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { navigateToHostWorkspaceRoute } from "@/navigation/workspace-route-navigation";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

export function PendingSidebarWorkspaceRow({
  workspace,
  selected,
  onWorkspacePress,
}: {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  onWorkspacePress?: () => void;
}) {
  const { t } = useTranslation();
  const failed = workspace.pendingCreation === "failed";
  const status = failed
    ? t(
        workspace.pendingOutcomeUnknown
          ? "sidebar.workspace.status.creationUnconfirmed"
          : "sidebar.workspace.status.creationFailed",
      )
    : t("sidebar.workspace.status.creating");
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const handlePress = useCallback(() => {
    onWorkspacePress?.();
    navigateToHostWorkspaceRoute(
      buildHostWorkspaceRoute(workspace.serverId, workspace.workspaceId),
    );
  }, [onWorkspacePress, workspace.serverId, workspace.workspaceId]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={[styles.row, selected && styles.selected]}
      testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
    >
      <View style={styles.indicator}>
        {failed ? <Text style={styles.failed}>!</Text> : <StatusRing />}
      </View>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {workspace.name}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {status}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[2],
  },
  selected: { backgroundColor: theme.colors.surface2 },
  indicator: { width: 16, alignItems: "center" },
  failed: { color: theme.colors.foregroundMuted },
  copy: { flex: 1, minWidth: 0 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
