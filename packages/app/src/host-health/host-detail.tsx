import { useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { UsageMeter } from "@/usage/meter";
import { settingsStyles } from "@/styles/settings";
import {
  processAgentKey,
  useHostAgents,
  useHostMetrics,
  type HostAgents,
  type HostMetricsState,
} from "./data";
import {
  cpuTone,
  diskTone,
  formatBytes,
  formatCpuPercent,
  formatPercent,
  formatUptime,
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

type ProcessFilter = "all" | "agents";

export function HostDetail({
  serverId,
  label,
  compact,
}: {
  serverId: string;
  label: string;
  compact: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const state = useHostMetrics(serverId);
  const agents = useHostAgents();
  const status = resolveHostStatus(state);
  const running = agents.runningByServer.get(serverId) ?? 0;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.column}>
        <View style={styles.summary}>
          <View style={styles.summaryText}>
            {compact ? null : (
              <View style={styles.nameRow}>
                <HostStatusDot status={status} />
                <Text style={styles.name} numberOfLines={1}>
                  {label}
                </Text>
              </View>
            )}
            <Text style={styles.meta}>{detailMeta({ t, state, running })}</Text>
          </View>
          <View style={styles.summaryTrailing}>
            <SettingsInfoTip title={t("hostHealth.title")} info={t("hostHealth.thresholds")} />
            <HostStatusBadge status={status} />
          </View>
        </View>
        {state.kind === "metrics" ? (
          <View style={state.live ? null : styles.stale}>
            <MetricsCharts
              metrics={state.metrics}
              compact={compact}
              chartWindow={resolveChartWindow({
                sampleCount: state.metrics.history.cpuPercent.length,
                missed: state.live ? 0 : missedSamples(state.receivedAt, Date.now()),
              })}
            />
            <DiskVolumes metrics={state.metrics} />
            <ProcessTable
              serverId={serverId}
              metrics={state.metrics}
              compact={compact}
              agents={agents}
            />
          </View>
        ) : (
          <Text style={styles.hint}>
            {state.kind === "unsupported" ? t("hostHealth.unsupported") : null}
            {state.kind === "error" ? state.message : null}
            {state.kind === "waiting" ? t("hostHealth.waiting") : null}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

function detailMeta(input: {
  t: (key: string, options?: Record<string, unknown>) => string;
  state: HostMetricsState;
  running: number;
}): string {
  const { t, state, running } = input;
  if (state.kind !== "metrics") return "";
  const { metrics } = state;
  const parts = [metrics.osLabel, metrics.cpu.model, formatBytes(metrics.memory.totalBytes)].filter(
    (part) => part.length > 0,
  );
  if (running > 0) parts.push(t("hostHealth.agentsRunning", { count: running }));
  parts.push(
    state.live
      ? t("hostHealth.uptime", { time: formatUptime(metrics.uptimeSeconds) })
      : lastSeenLabel(t, state.receivedAt),
  );
  return parts.join(" · ");
}

function MetricsCharts({
  metrics,
  compact,
  chartWindow,
}: {
  metrics: HostMetricsSnapshot;
  compact: boolean;
  chartWindow: ChartWindow;
}): ReactElement {
  const { t } = useTranslation();
  const cpu = cpuTone(metrics.cpu.percent);
  const mem = memoryTone(metrics.memory.pressure);
  const memory = formatUsage({
    usedBytes: metrics.memory.usedBytes,
    totalBytes: metrics.memory.totalBytes,
    units: "binary",
  });
  const pressure = metrics.memory.pressure;
  return (
    <View style={settingsStyles.section}>
      <View style={[settingsStyles.card, compact ? null : styles.chartsRow]}>
        <View style={styles.chart}>
          <View style={styles.chartHeader}>
            <Text style={styles.label}>{t("hostHealth.cpu")}</Text>
            <Text style={[styles.value, toneText(cpu)]}>
              {metrics.cpu.percent == null ? "–" : formatPercent(metrics.cpu.percent)}
            </Text>
          </View>
          <View style={styles.chartBody}>
            <Sparkline
              values={metrics.history.cpuPercent}
              tone={cpu}
              height={120}
              window={chartWindow}
              grid
              thresholdPercent={90}
            />
          </View>
          <ChartAxis minutes={chartWindow.minutes} />
        </View>
        <View style={[styles.chart, compact ? settingsStyles.rowBorder : styles.chartDivider]}>
          <View style={styles.chartHeader}>
            <Text style={styles.label}>{t("hostHealth.memory")}</Text>
            <Text style={[styles.value, toneText(mem)]}>
              {memory.used}
              <Text style={styles.unit}> / {memory.total}</Text>
            </Text>
          </View>
          <View style={styles.chartBody}>
            <Sparkline
              values={metrics.history.memoryPercent}
              tone={mem}
              height={120}
              window={chartWindow}
              grid
            />
          </View>
          <ChartAxis
            minutes={chartWindow.minutes}
            middle={pressure ? t(`hostHealth.pressure.${pressure}`) : undefined}
            middleTone={mem}
          />
        </View>
      </View>
    </View>
  );
}

function ChartAxis({
  minutes,
  middle,
  middleTone = "default",
}: {
  minutes: number;
  middle?: string;
  middleTone?: MetricTone;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.axis}>
      <Text style={styles.axisText}>{t("hostHealth.minutesAgo", { minutes })}</Text>
      {middle ? <Text style={[styles.axisText, toneText(middleTone)]}>{middle}</Text> : null}
      <Text style={styles.axisText}>{t("hostHealth.now")}</Text>
    </View>
  );
}

function DiskVolumes({ metrics }: { metrics: HostMetricsSnapshot }): ReactElement | null {
  const { t } = useTranslation();
  if (metrics.disks.length === 0) return null;
  return (
    <SettingsSection title={t("hostHealth.diskVolumes")}>
      <View style={settingsStyles.card}>
        {metrics.disks.map((disk, index) => {
          const usage = formatUsage({
            usedBytes: disk.usedBytes,
            totalBytes: disk.totalBytes,
            units: "decimal",
          });
          const percent = percentOf(disk.usedBytes, disk.totalBytes);
          const tone = diskTone(disk);
          return (
            <View
              key={disk.mount}
              style={[styles.volume, index > 0 ? settingsStyles.rowBorder : null]}
            >
              <View style={styles.volumeHeader}>
                <View style={styles.volumeName}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {disk.name}
                  </Text>
                  {disk.name !== disk.mount ? (
                    <Text style={styles.mount} numberOfLines={1}>
                      {disk.mount}
                    </Text>
                  ) : null}
                </View>
                <Text style={[styles.volumeValue, toneText(tone)]}>
                  {usage.used}
                  <Text style={styles.unit}>
                    {" "}
                    / {usage.total} · {formatPercent(percent)}
                  </Text>
                </Text>
              </View>
              <UsageMeter percent={percent} tone={tone} />
            </View>
          );
        })}
      </View>
    </SettingsSection>
  );
}

function ProcessTable({
  serverId,
  metrics,
  compact,
  agents,
}: {
  serverId: string;
  metrics: HostMetricsSnapshot;
  compact: boolean;
  agents: HostAgents;
}): ReactElement {
  const { t } = useTranslation();
  const [sort, setSort] = useState<ProcessSort>("cpu");
  const [filter, setFilter] = useState<ProcessFilter>("all");
  const rows = useMemo(() => {
    const sorted = sortProcesses(metrics.processes, sort);
    return filter === "agents" ? sorted.filter((process) => process.agentId) : sorted;
  }, [filter, metrics.processes, sort]);
  const sortOptions = useMemo(
    () => [
      { value: "cpu" as const, label: t("hostHealth.sortCpu") },
      { value: "memory" as const, label: t("hostHealth.sortMemory") },
    ],
    [t],
  );
  const filterOptions = useMemo(
    () => [
      { value: "all" as const, label: t("hostHealth.filterAll") },
      { value: "agents" as const, label: t("hostHealth.filterAgents") },
    ],
    [t],
  );

  const countLabel = useMemo(
    () => (
      <Text style={styles.count}>
        {t("hostHealth.processCount", { shown: rows.length, total: metrics.processes.length })}
      </Text>
    ),
    [metrics.processes.length, rows.length, t],
  );

  return (
    <SettingsSection title={t("hostHealth.processes")} trailing={countLabel}>
      <View style={settingsStyles.card}>
        <View style={styles.toolbar}>
          <SegmentedControl
            size="xs"
            value={filter}
            onValueChange={setFilter}
            options={filterOptions}
            testID="host-health-process-filter"
          />
          <SegmentedControl
            size="xs"
            value={sort}
            onValueChange={setSort}
            options={sortOptions}
            testID="host-health-process-sort"
          />
        </View>
        <View style={[styles.tableRow, styles.tableHead, settingsStyles.rowBorder]}>
          <Text style={[styles.headText, styles.nameCell]}>{t("hostHealth.columns.process")}</Text>
          {compact ? null : (
            <Text style={[styles.headText, styles.pidCell]}>{t("hostHealth.columns.pid")}</Text>
          )}
          <Text style={[styles.headText, styles.numberCell]}>{t("hostHealth.columns.cpu")}</Text>
          <Text style={[styles.headText, styles.numberCell]}>{t("hostHealth.columns.memory")}</Text>
          {compact ? null : (
            <Text style={[styles.headText, styles.agentCell]}>{t("hostHealth.columns.agent")}</Text>
          )}
        </View>
        {rows.length === 0 ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={styles.hint}>{t("hostHealth.noAgentProcesses")}</Text>
          </View>
        ) : null}
        {rows.map((process) => {
          const agent = process.agentId
            ? agents.byKey.get(processAgentKey(serverId, process.agentId))
            : undefined;
          return (
            <View key={process.pid} style={[styles.tableRowWrap, settingsStyles.rowBorder]}>
              <View style={styles.tableRow}>
                <Text
                  style={[styles.cellText, styles.nameCell, styles.mono]}
                  numberOfLines={compact ? 2 : 1}
                >
                  {process.name}
                </Text>
                {compact ? null : (
                  <Text style={[styles.cellText, styles.pidCell, styles.number, styles.muted]}>
                    {process.pid}
                  </Text>
                )}
                <Text
                  style={[
                    styles.cellText,
                    styles.numberCell,
                    styles.number,
                    sort === "cpu" ? toneText(cpuTone(process.cpuPercent)) : styles.muted,
                  ]}
                >
                  {formatCpuPercent(process.cpuPercent)}
                </Text>
                <Text
                  style={[
                    styles.cellText,
                    styles.numberCell,
                    styles.number,
                    sort === "memory" ? null : styles.muted,
                  ]}
                >
                  {formatBytes(process.memoryBytes)}
                </Text>
                {compact ? null : (
                  <View style={styles.agentCell}>
                    {agent ? (
                      <AgentTag serverId={serverId} agent={agent} />
                    ) : (
                      <Text style={[styles.cellText, styles.muted]}>—</Text>
                    )}
                  </View>
                )}
              </View>
              {compact && agent ? <AgentTag serverId={serverId} agent={agent} /> : null}
            </View>
          );
        })}
      </View>
    </SettingsSection>
  );
}

function toneText(tone: MetricTone) {
  if (tone === "danger") return styles.danger;
  if (tone === "warning") return styles.warning;
  return null;
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  content: {
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
  },
  column: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[6],
  },
  summaryTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summaryText: {
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
    fontSize: theme.fontSize.lg,
  },
  meta: {
    marginTop: theme.spacing[1],
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
  chartsRow: {
    flexDirection: "row",
  },
  chart: {
    flex: 1,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  chartDivider: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  chartHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  chartBody: {
    marginTop: theme.spacing[2],
    height: 120,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontFamily: theme.fontFamily.mono,
    fontVariant: ["tabular-nums"],
  },
  unit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  axis: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: theme.spacing[1],
  },
  axisText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  volume: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  volumeHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[3],
  },
  volumeName: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  mount: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  volumeValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    fontVariant: ["tabular-nums"],
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  tableHead: {
    minHeight: 32,
    paddingHorizontal: theme.spacing[4],
  },
  tableRowWrap: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[1],
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: 0,
  },
  headText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  cellText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
  },
  number: {
    fontFamily: theme.fontFamily.mono,
    fontVariant: ["tabular-nums"],
  },
  nameCell: {
    flex: 1,
    minWidth: 0,
  },
  pidCell: {
    width: 56,
    textAlign: "right",
  },
  numberCell: {
    width: 64,
    textAlign: "right",
  },
  agentCell: {
    width: 180,
    alignItems: "flex-start",
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
}));
