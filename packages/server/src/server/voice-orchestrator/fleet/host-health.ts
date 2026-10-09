import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import type { VoiceFleetHostHealth } from "@getpaseo/protocol/voice-fleet/types";

const BUSY_CPU_PERCENT = 20;

export function summarizeHostHealth(metrics: HostMetricsSnapshot): VoiceFleetHostHealth {
  const disk = metrics.disks
    .filter((entry) => entry.totalBytes > 0)
    .sort((left, right) => right.totalBytes - left.totalBytes)[0];
  return {
    cpuPercent: metrics.cpu.percent === null ? null : Math.round(metrics.cpu.percent),
    memoryPercent:
      metrics.memory.totalBytes > 0
        ? Math.round((metrics.memory.usedBytes / metrics.memory.totalBytes) * 100)
        : null,
    memoryTotalBytes: metrics.memory.totalBytes,
    memoryPressure: metrics.memory.pressure,
    diskFreeBytes: disk ? disk.totalBytes - disk.usedBytes : null,
    busiest: metrics.processes
      .toSorted((left, right) => right.cpuPercent - left.cpuPercent)
      .slice(0, 3)
      .filter((entry) => entry.cpuPercent >= BUSY_CPU_PERCENT)
      .map((entry) => `${entry.name} ${Math.round(entry.cpuPercent)}%`),
    uptimeHours: Math.round(metrics.uptimeSeconds / 3600),
  };
}

/**
 * One spoken-style line. `coarse` rounds the numbers so a snapshot only changes when the
 * load really does, instead of on every sample.
 */
export function formatHostHealth(
  label: string,
  health: VoiceFleetHostHealth,
  options?: { coarse?: boolean },
): string {
  const round = (value: number, step: number) =>
    options?.coarse ? Math.round(value / step) * step : value;
  const parts = [
    health.cpuPercent !== null ? `CPU at ${round(health.cpuPercent, 10)}%` : null,
    health.memoryPercent !== null
      ? `memory at ${round(health.memoryPercent, 5)}% of ${formatBytes(health.memoryTotalBytes)}${health.memoryPressure && health.memoryPressure !== "normal" ? ` (pressure ${health.memoryPressure})` : ""}`
      : null,
    health.diskFreeBytes !== null
      ? `${formatBytes(health.diskFreeBytes, options?.coarse)} free on disk`
      : null,
    !options?.coarse && health.busiest.length > 0 ? `busiest: ${health.busiest.join(", ")}` : null,
    options?.coarse ? null : `up ${health.uptimeHours} hours`,
  ].filter((part): part is string => part !== null);
  return `${label}: ${parts.join("; ")}`;
}

function formatBytes(bytes: number, coarse = false): string {
  const gb = bytes / 1024 ** 3;
  if (coarse) return `${gb >= 100 ? Math.round(gb / 10) * 10 : Math.round(gb)} GB`;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}
