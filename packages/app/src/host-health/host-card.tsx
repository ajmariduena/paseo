import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import { UsageMeter } from "@/usage/meter";
import { settingsStyles } from "@/styles/settings";
import { buildHostHealthRoute } from "@/utils/host-routes";
import { processAgentKey, useHostMetrics, type HostAgents, type HostMetricsState } from "./data";
import {
  cpuTone,
  diskTone,
  formatBytes,
  formatCpuPercent,
  formatPercent,
  formatUsage,
  memoryTone,
  missedSamples,
  percentOf,
  resolveChartWindow,
  sortProcesses,
  type ChartWindow,
  type MetricTone,
  type ProcessSort,
} from "./model";
import {
  AgentTag,
  HostStatusBadge,
  HostStatusDot,
  lastSeenLabel,
  resolveHostStatus,
} from "./parts";
import { Sparkline } from "./sparkline";

const ThemedChevron = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export const HostCard = memo(function HostCard({
  serverId,
  label,
  sort,
  compact,
  agents,
}: {
  serverId: string;
  label: string;
  sort: ProcessSort;
  compact: boolean;
  agents: HostAgents;
}): ReactElement {
  const { t } = useTranslation();
  const state = useHostMetrics(serverId);
  const status = resolveHostStatus(state);
  const handlePress = useCallback(() => {
    router.push(buildHostHealthRoute(serverId));
  }, [serverId]);
  const running = agents.runningByServer.get(serverId) ?? 0;
  const meta = hostMeta({ t, state, running });

  return (
    <View style={settingsStyles.card} testID={`host-health-card-${serverId}`}>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        style={styles.headerRow}
        testID={`host-health-open-${serverId}`}
      >
        <View style={styles.headerText}>
          <View style={styles.nameRow}>
            <HostStatusDot status={status} />
            <Text style={styles.name} numberOfLines={1}>
              {label}
            </Text>
          </View>
          {meta ? (
            <Text style={styles.meta} numberOfLines={2}>
              {meta}
            </Text>
          ) : null}
        </View>
        <HostStatusBadge status={status} />
        <ThemedChevron size={14} />
      </Pressable>
      <HostCardBody
        serverId={serverId}
        state={state}
        sort={sort}
        compact={compact}
        agents={agents}
      />
    </View>
  );
});

function hostMeta(input: {
  t: (key: string, options?: Record<string, unknown>) => string;
  state: HostMetricsState;
  running: number;
}): string | null {
  const { t, state, running } = input;
  if (state.kind !== "metrics") return null;
  const parts = [state.metrics.osLabel, formatBytes(state.metrics.memory.totalBytes)];
  if (!state.live) parts.push(lastSeenLabel(t, state.receivedAt));
  if (running > 0) parts.push(t("hostHealth.agentsRunning", { count: running }));
  return parts.join(" · ");
}

function HostCardBody({
  serverId,
  state,
  sort,
  compact,
  agents,
}: {
  serverId: string;
  state: HostMetricsState;
  sort: ProcessSort;
  compact: boolean;
  agents: HostAgents;
}): ReactElement | null {
  const { t } = useTranslation();
  if (state.kind === "unsupported" || state.kind === "error") {
    return (
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <Text style={styles.hint}>
          {state.kind === "unsupported" ? t("hostHealth.unsupported") : state.message}
        </Text>
      </View>
    );
  }
  if (state.kind === "waiting") {
    return null;
  }
  const { metrics, live, receivedAt } = state;
  const chartWindow = resolveChartWindow({
    sampleCount: metrics.history.cpuPercent.length,
    missed: live ? 0 : missedSamples(receivedAt, Date.now()),
  });
  return (
    <View style={live ? null : styles.stale}>
      <View style={[styles.bodyRow, settingsStyles.rowBorder]}>
        <MetricsGrid metrics={metrics} live={live} chartWindow={chartWindow} compact={compact} />
      </View>
      <View style={[styles.bodyRow, settingsStyles.rowBorder]}>
        <TopProcesses
          serverId={serverId}
          metrics={metrics}
          sort={sort}
          limit={compact ? 3 : 4}
          compact={compact}
          agents={agents}
        />
      </View>
    </View>
  );
}

function MetricsGrid({
  metrics,
  live,
  chartWindow,
  compact,
}: {
  metrics: HostMetricsSnapshot;
  live: boolean;
  chartWindow: ChartWindow;
  compact: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const disk = metrics.disks[0];
  const memory = formatUsage({
    usedBytes: metrics.memory.usedBytes,
    totalBytes: metrics.memory.totalBytes,
    units: "binary",
  });
  const pressure = metrics.memory.pressure;
  const cpu = cpuTone(metrics.cpu.percent);
  const mem = memoryTone(pressure);
  const diskUsage = disk
    ? formatUsage({ usedBytes: disk.usedBytes, totalBytes: disk.totalBytes, units: "decimal" })
    : null;
  const memoryHint = pressure
    ? t(`hostHealth.pressure.${pressure}`)
    : t("hostHealth.memoryUsed", {
        percent: formatPercent(percentOf(metrics.memory.usedBytes, metrics.memory.totalBytes)),
      });
  let windowHint = t("hostHealth.lastMinutes", { minutes: chartWindow.minutes });
  if (!live) windowHint = t("hostHealth.lastKnown");
  else if (compact) windowHint = t("hostHealth.minutesAgo", { minutes: chartWindow.minutes });
  return (
    <View style={styles.metrics}>
      <View style={styles.metric}>
        <Text style={styles.metricLabel}>{t("hostHealth.cpu")}</Text>
        <Text style={[styles.metricValue, toneText(cpu)]}>
          {metrics.cpu.percent == null ? "–" : formatPercent(metrics.cpu.percent)}
        </Text>
        <View style={styles.spark}>
          <Sparkline
            values={metrics.history.cpuPercent}
            tone={cpu}
            height={28}
            window={chartWindow}
          />
        </View>
        <Text style={styles.metricHint} numberOfLines={1}>
          {windowHint}
        </Text>
      </View>
      <View style={styles.metric}>
        <Text style={styles.metricLabel}>{t("hostHealth.memory")}</Text>
        <Text style={[styles.metricValue, toneText(mem)]} numberOfLines={1}>
          {memory.used}
          <Text style={styles.metricUnit}> / {memory.total}</Text>
        </Text>
        <View style={styles.spark}>
          <Sparkline
            values={metrics.history.memoryPercent}
            tone={mem}
            height={28}
            window={chartWindow}
          />
        </View>
        <Text style={[styles.metricHint, toneText(mem)]} numberOfLines={compact ? 2 : 1}>
          {memoryHint}
        </Text>
      </View>
      <View style={styles.metric}>
        <Text style={styles.metricLabel}>{t("hostHealth.disk")}</Text>
        <Text style={[styles.metricValue, toneText(diskTone(disk))]} numberOfLines={1}>
          {diskUsage ? diskUsage.used : "–"}
          {diskUsage ? <Text style={styles.metricUnit}> / {diskUsage.total}</Text> : null}
        </Text>
        <View style={styles.diskBar}>
          <UsageMeter
            percent={disk ? percentOf(disk.usedBytes, disk.totalBytes) : 0}
            tone={diskTone(disk)}
          />
        </View>
        <Text style={styles.metricHint} numberOfLines={1}>
          {disk ? formatPercent(percentOf(disk.usedBytes, disk.totalBytes)) : ""}
          {disk && !compact ? ` · ${disk.name}` : ""}
        </Text>
      </View>
    </View>
  );
}

function TopProcesses({
  serverId,
  metrics,
  sort,
  limit,
  compact,
  agents,
}: {
  serverId: string;
  metrics: HostMetricsSnapshot;
  sort: ProcessSort;
  limit: number;
  compact: boolean;
  agents: HostAgents;
}): ReactElement {
  const { t } = useTranslation();
  const rows = useMemo(
    () => sortProcesses(metrics.processes, sort).slice(0, limit),
    [limit, metrics.processes, sort],
  );
  return (
    <View>
      <View style={styles.processHeader}>
        <Text style={styles.metricLabel}>{t("hostHealth.topProcesses")}</Text>
        <Text style={styles.processSortLabel}>
          {sort === "cpu" ? t("hostHealth.byCpu") : t("hostHealth.byMemory")}
        </Text>
      </View>
      {rows.map((process) => {
        const agent = process.agentId
          ? agents.byKey.get(processAgentKey(serverId, process.agentId))
          : undefined;
        return (
          <View key={process.pid} style={compact ? styles.processRowStacked : styles.processRow}>
            <View style={styles.processMain}>
              <View style={styles.processName}>
                <Text style={styles.processText} numberOfLines={compact ? 2 : 1}>
                  {process.name}
                </Text>
                {agent && !compact ? <AgentTag serverId={serverId} agent={agent} /> : null}
              </View>
              <Text style={[styles.processNumber, sort === "cpu" ? null : styles.muted]}>
                {formatCpuPercent(process.cpuPercent)}
              </Text>
              <Text style={[styles.processNumber, sort === "memory" ? null : styles.muted]}>
                {formatBytes(process.memoryBytes)}
              </Text>
            </View>
            {agent && compact ? <AgentTag serverId={serverId} agent={agent} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function toneText(tone: MetricTone) {
  if (tone === "danger") return styles.danger;
  if (tone === "warning") return styles.warning;
  return null;
}

const styles = StyleSheet.create((theme) => ({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  name: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  meta: {
    marginTop: theme.spacing[0.5],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  stale: {
    opacity: 0.45,
  },
  bodyRow: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  metrics: {
    flexDirection: "row",
    gap: theme.spacing[4],
  },
  metric: {
    flex: 1,
    minWidth: 0,
  },
  metricLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  metricValue: {
    marginTop: theme.spacing[0.5],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontFamily: theme.fontFamily.mono,
    fontVariant: ["tabular-nums"],
  },
  metricUnit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  metricHint: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  spark: {
    marginTop: theme.spacing[1.5],
    height: 28,
  },
  diskBar: {
    marginTop: theme.spacing[1.5],
    height: 28,
    justifyContent: "center",
  },
  danger: {
    color: theme.colors.statusDanger,
  },
  warning: {
    color: theme.colors.statusWarning,
  },
  muted: {
    color: theme.colors.foregroundMuted,
  },
  processHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: theme.spacing[2],
  },
  processSortLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  processRow: {
    minHeight: 28,
    justifyContent: "center",
  },
  processRowStacked: {
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1],
  },
  processMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  processName: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  processText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  processNumber: {
    width: 64,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    fontVariant: ["tabular-nums"],
  },
}));
