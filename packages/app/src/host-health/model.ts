import type {
  HostDisk,
  HostMemoryPressure,
  HostMetricsSnapshot,
  HostProcess,
} from "@getpaseo/protocol/host-metrics/types";

export type HostHealth = "healthy" | "pressure" | "critical";
export type MetricTone = "default" | "warning" | "danger";
export type ProcessSort = "cpu" | "memory";

export const HISTORY_CAPACITY = 300;
export const POLL_INTERVAL_MS = 2_000;

const CPU_WARN_PERCENT = 75;
const CPU_CRITICAL_PERCENT = 90;
const DISK_WARN_PERCENT = 90;
const DISK_CRITICAL_PERCENT = 95;
// A build spikes CPU for a few seconds; only a sustained minute counts against the host.
const SUSTAINED_CPU_SAMPLES = 30;

export function percentOf(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

export function sustainedCpuPercent(metrics: HostMetricsSnapshot): number | null {
  const recent = metrics.history.cpuPercent.slice(-SUSTAINED_CPU_SAMPLES);
  if (recent.length === 0) return metrics.cpu.percent;
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

export function cpuTone(percent: number | null): MetricTone {
  if (percent == null) return "default";
  if (percent >= CPU_CRITICAL_PERCENT) return "danger";
  if (percent >= CPU_WARN_PERCENT) return "warning";
  return "default";
}

export function memoryTone(pressure: HostMemoryPressure | null): MetricTone {
  if (pressure === "critical") return "danger";
  if (pressure === "warn") return "warning";
  return "default";
}

export function diskTone(disk: HostDisk | undefined): MetricTone {
  if (!disk) return "default";
  const percent = percentOf(disk.usedBytes, disk.totalBytes);
  if (percent >= DISK_CRITICAL_PERCENT) return "danger";
  if (percent >= DISK_WARN_PERCENT) return "warning";
  return "default";
}

export function resolveHostHealth(metrics: HostMetricsSnapshot): HostHealth {
  const tones = new Set([
    cpuTone(sustainedCpuPercent(metrics)),
    memoryTone(metrics.memory.pressure),
    diskTone(metrics.disks[0]),
  ]);
  if (tones.has("danger")) return "critical";
  if (tones.has("warning")) return "pressure";
  return "healthy";
}

export function sortProcesses(processes: readonly HostProcess[], by: ProcessSort): HostProcess[] {
  return [...processes].sort((left, right) =>
    by === "memory" ? right.memoryBytes - left.memoryBytes : right.cpuPercent - left.cpuPercent,
  );
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const TIB = 1024 ** 4;
const SAMPLES_PER_MINUTE = 60_000 / POLL_INTERVAL_MS;
const MAX_WINDOW_MINUTES = HISTORY_CAPACITY / SAMPLES_PER_MINUTE;

export function formatBytes(bytes: number): string {
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(1)} TB`;
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  return `${Math.round(bytes / MIB)} MB`;
}

function formatQuantity(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

function formatTotal(value: number): string {
  return formatQuantity(value).replace(/\.0$/, "");
}

function usageUnit(totalBytes: number, base: number): { unit: number; suffix: string } {
  if (totalBytes >= base ** 4) return { unit: base ** 4, suffix: "TB" };
  if (totalBytes >= base ** 3) return { unit: base ** 3, suffix: "GB" };
  return { unit: base ** 2, suffix: "MB" };
}

/**
 * Used and total in the total's unit, so "14.1 / 16 GB" reads as one quantity. Memory is binary
 * (a 16 GB machine has 16 GiB); disks are decimal, which is what Finder and `df -H` show.
 */
export function formatUsage(input: {
  usedBytes: number;
  totalBytes: number;
  units: "binary" | "decimal";
}): { used: string; total: string } {
  const base = input.units === "binary" ? 1024 : 1000;
  const { unit, suffix } = usageUnit(input.totalBytes, base);
  return {
    used: formatQuantity(input.usedBytes / unit),
    total: `${formatTotal(input.totalBytes / unit)} ${suffix}`,
  };
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

export function formatCpuPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * SVG path for a percent series in a `capacity`-wide viewBox. The series is right-aligned while it
 * fills, so a short history (a fresh sampler) grows from the right edge like a live chart.
 * `endIndex` lets an offline host's last-known series stop short of "now".
 */
export function sparklinePaths(input: {
  values: readonly number[];
  height: number;
  capacity?: number;
  endIndex?: number;
}): { line: string; area: string } | null {
  const capacity = input.capacity ?? HISTORY_CAPACITY;
  const values = input.values.slice(-capacity);
  if (values.length < 2) return null;
  const end = input.endIndex ?? capacity - 1;
  const start = end - (values.length - 1);
  const points = values.map((value, index) => {
    const x = start + index;
    const clamped = Math.min(100, Math.max(0, value));
    const y = input.height - (clamped / 100) * input.height;
    return `${x.toFixed(1)},${y.toFixed(2)}`;
  });
  const line = `M${points.join(" L")}`;
  const area = `${line} L${end.toFixed(1)},${input.height} L${start.toFixed(1)},${input.height} Z`;
  return { line, area };
}

/** How many samples an offline host has missed since it went quiet. */
export function missedSamples(lastSampledAt: number, now: number): number {
  return Math.max(0, Math.floor((now - lastSampledAt) / POLL_INTERVAL_MS));
}

export interface ChartWindow {
  minutes: number;
  capacity: number;
  /** Where the newest sample sits; short of the right edge while the host is offline. */
  endIndex: number;
}

/**
 * The daemon only keeps history while someone is watching, so a freshly opened screen has seconds
 * of it. The window grows a minute at a time with the history instead of drawing a sliver against
 * a 10 minute axis.
 */
export function resolveChartWindow(input: { sampleCount: number; missed: number }): ChartWindow {
  const span = input.sampleCount + input.missed;
  const minutes = Math.min(MAX_WINDOW_MINUTES, Math.max(1, Math.ceil(span / SAMPLES_PER_MINUTE)));
  const capacity = minutes * SAMPLES_PER_MINUTE;
  return { minutes, capacity, endIndex: Math.max(1, capacity - 1 - input.missed) };
}
