import { describe, expect, it } from "vitest";
import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import {
  formatBytes,
  formatUptime,
  formatUsage,
  resolveChartWindow,
  resolveHostHealth,
  sortProcesses,
  sparklinePaths,
} from "./model";

const GIB = 1024 ** 3;

function snapshot(overrides: Partial<HostMetricsSnapshot> = {}): HostMetricsSnapshot {
  return {
    sampledAt: "2026-10-08T20:00:00.000Z",
    sampleIntervalMs: 2000,
    hostname: "mini",
    platform: "darwin",
    osLabel: "macOS 15.1",
    arch: "arm64",
    uptimeSeconds: 100,
    cpu: { model: "Apple M2", cores: 8, percent: 20 },
    memory: { totalBytes: 16 * GIB, usedBytes: 8 * GIB, pressure: "normal" },
    disks: [{ mount: "/", name: "Macintosh HD", totalBytes: 460 * GIB, usedBytes: 200 * GIB }],
    history: { cpuPercent: [20, 22, 18], memoryPercent: [50, 50, 51] },
    processes: [],
    ...overrides,
  };
}

describe("resolveHostHealth", () => {
  it("is healthy under the thresholds", () => {
    expect(resolveHostHealth(snapshot())).toBe("healthy");
  });

  it("ignores a short CPU spike and flags a sustained one", () => {
    const spike = [...Array.from({ length: 29 }, () => 10), 100];
    expect(resolveHostHealth(snapshot({ history: { cpuPercent: spike, memoryPercent: [] } }))).toBe(
      "healthy",
    );
    const sustained = Array.from({ length: 30 }, () => 95);
    expect(
      resolveHostHealth(snapshot({ history: { cpuPercent: sustained, memoryPercent: [] } })),
    ).toBe("critical");
  });

  it("follows memory pressure rather than percent used", () => {
    const full = { totalBytes: 16 * GIB, usedBytes: 15 * GIB };
    expect(resolveHostHealth(snapshot({ memory: { ...full, pressure: "normal" } }))).toBe(
      "healthy",
    );
    expect(resolveHostHealth(snapshot({ memory: { ...full, pressure: "warn" } }))).toBe("pressure");
    expect(resolveHostHealth(snapshot({ memory: { ...full, pressure: "critical" } }))).toBe(
      "critical",
    );
  });

  it("flags a nearly full main disk", () => {
    const disk = { mount: "/", name: "/", totalBytes: 100 * GIB, usedBytes: 96 * GIB };
    expect(resolveHostHealth(snapshot({ disks: [disk] }))).toBe("critical");
  });
});

describe("sortProcesses", () => {
  const processes = [
    { pid: 1, name: "a", cpuPercent: 5, memoryBytes: 900, agentId: null },
    { pid: 2, name: "b", cpuPercent: 50, memoryBytes: 100, agentId: "agent-1" },
  ];

  it("sorts by CPU or memory, descending", () => {
    expect(sortProcesses(processes, "cpu").map((p) => p.pid)).toEqual([2, 1]);
    expect(sortProcesses(processes, "memory").map((p) => p.pid)).toEqual([1, 2]);
  });
});

describe("formatting", () => {
  it("formats bytes, usage and uptime", () => {
    expect(formatBytes(780 * 1024 ** 2)).toBe("780 MB");
    expect(formatBytes(4.1 * GIB)).toBe("4.1 GB");
    expect(formatUsage({ usedBytes: 14.1 * GIB, totalBytes: 16 * GIB, units: "binary" })).toEqual({
      used: "14.1",
      total: "16 GB",
    });
    expect(formatUsage({ usedBytes: 878e9, totalBytes: 994.6e9, units: "decimal" })).toEqual({
      used: "878",
      total: "995 GB",
    });
    expect(formatUsage({ usedBytes: 1.14e12, totalBytes: 2e12, units: "decimal" })).toEqual({
      used: "1.1",
      total: "2 TB",
    });
    expect(formatUsage({ usedBytes: 19 * GIB, totalBytes: 24 * GIB, units: "binary" })).toEqual({
      used: "19.0",
      total: "24 GB",
    });
    expect(formatUsage({ usedBytes: 140e6, totalBytes: 241e6, units: "decimal" })).toEqual({
      used: "140",
      total: "241 MB",
    });
    expect(formatUptime(6 * 86_400 + 4 * 3_600)).toBe("6d 4h");
    expect(formatUptime(3_660)).toBe("1h 1m");
  });
});

describe("sparklinePaths", () => {
  it("right-aligns a short series and maps percent to height", () => {
    const paths = sparklinePaths({ values: [0, 100], height: 20, capacity: 10 });
    expect(paths?.line).toBe("M8.0,20.00 L9.0,0.00");
    expect(paths?.area).toBe("M8.0,20.00 L9.0,0.00 L9.0,20 L8.0,20 Z");
  });

  it("needs two points", () => {
    expect(sparklinePaths({ values: [5], height: 20 })).toBeNull();
  });
});

describe("resolveChartWindow", () => {
  it("grows a minute at a time with the history, up to 10 minutes", () => {
    expect(resolveChartWindow({ sampleCount: 5, missed: 0 })).toEqual({
      minutes: 1,
      capacity: 30,
      endIndex: 29,
    });
    expect(resolveChartWindow({ sampleCount: 31, missed: 0 }).minutes).toBe(2);
    expect(resolveChartWindow({ sampleCount: 300, missed: 0 }).minutes).toBe(10);
  });

  it("stops an offline series where it went quiet", () => {
    expect(resolveChartWindow({ sampleCount: 300, missed: 90 })).toEqual({
      minutes: 10,
      capacity: 300,
      endIndex: 209,
    });
    expect(resolveChartWindow({ sampleCount: 300, missed: 10_000 }).endIndex).toBe(1);
  });
});
