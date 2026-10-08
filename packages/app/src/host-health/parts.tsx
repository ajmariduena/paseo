import { useCallback, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { formatCompactTimeAgo } from "@/utils/time";
import type { HostMetricsState, ProcessAgent } from "./data";
import { resolveHostHealth } from "./model";

export type HostStatus =
  | "healthy"
  | "pressure"
  | "critical"
  | "offline"
  | "connecting"
  | "unsupported"
  | "error";

export function resolveHostStatus(state: HostMetricsState): HostStatus {
  switch (state.kind) {
    case "metrics":
      return state.live ? resolveHostHealth(state.metrics) : "offline";
    case "unsupported":
      return "unsupported";
    case "error":
      return "error";
    case "waiting":
      return state.status === "offline" || state.status === "error" ? "offline" : "connecting";
  }
}

const BADGE_VARIANT: Record<HostStatus, StatusBadgeVariant> = {
  healthy: "success",
  pressure: "warning",
  critical: "error",
  offline: "muted",
  connecting: "muted",
  unsupported: "muted",
  error: "muted",
};

export function HostStatusBadge({ status }: { status: HostStatus }): ReactElement {
  const { t } = useTranslation();
  return <StatusBadge label={t(`hostHealth.health.${status}`)} variant={BADGE_VARIANT[status]} />;
}

export function HostStatusDot({ status }: { status: HostStatus }): ReactElement {
  return <View style={[styles.dot, DOT_STYLE[status]]} />;
}

export function lastSeenLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  receivedAt: number,
): string {
  const time = formatCompactTimeAgo(new Date(receivedAt));
  return time === "now" ? t("hostHealth.lastSeenNow") : t("hostHealth.lastSeen", { time });
}

const ThemedBot = withUnistyles(Bot, (theme) => ({ color: theme.colors.foregroundMuted }));

export function AgentTag({
  serverId,
  agent,
}: {
  serverId: string;
  agent: ProcessAgent;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    router.push(buildHostAgentDetailRoute(serverId, agent.agentId, agent.workspaceId ?? undefined));
  }, [agent.agentId, agent.workspaceId, serverId]);
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel={t("hostHealth.openAgent", { title: agent.title })}
      style={styles.tag}
    >
      <ThemedBot size={11} strokeWidth={2} />
      <Text style={styles.tagText} numberOfLines={1}>
        {agent.title}
        {agent.projectName ? <Text style={styles.tagProject}> · {agent.projectName}</Text> : null}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  dotHealthy: { backgroundColor: theme.colors.statusDotSuccess },
  dotPressure: { backgroundColor: theme.colors.statusDotWarning },
  dotCritical: { backgroundColor: theme.colors.statusDotDanger },
  dotIdle: {
    borderWidth: 1.5,
    borderColor: theme.colors.foregroundMuted,
  },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  tagText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tagProject: {
    color: theme.colors.foregroundMuted,
  },
}));

const DOT_STYLE: Record<HostStatus, object> = {
  healthy: styles.dotHealthy,
  pressure: styles.dotPressure,
  critical: styles.dotCritical,
  offline: styles.dotIdle,
  connecting: styles.dotIdle,
  unsupported: styles.dotIdle,
  error: styles.dotIdle,
};
