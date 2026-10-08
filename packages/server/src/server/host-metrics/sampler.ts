import type pino from "pino";
import type {
  HostDisk,
  HostMetricsSnapshot,
  HostProcess,
} from "@getpaseo/protocol/host-metrics/types";
import {
  collectDisks,
  collectMemory,
  collectProcessRows,
  cpuPercentBetween,
  readCpuTimes,
  readDarwinMainVolumeName,
  readOsLabel,
  resolveAgentIds,
  type AgentIdCache,
  type CpuTimes,
  type HostMemory,
} from "./collect.js";
import { selectTopProcesses } from "./parse.js";
import { createNodeHostMetricsSystem, type HostMetricsSystem } from "./system.js";

export interface HostMetricsTimers {
  now(): number;
  every(callback: () => void, ms: number): () => void;
  sleep(ms: number): Promise<void>;
}

export interface HostMetricsSamplerOptions {
  logger: pino.Logger;
  system?: HostMetricsSystem;
  timers?: HostMetricsTimers;
  sampleIntervalMs?: number;
  idleTimeoutMs?: number;
  diskIntervalMs?: number;
  historyLength?: number;
  initialCpuWindowMs?: number;
  processLimit?: number;
}

const nodeTimers: HostMetricsTimers = {
  now: () => Date.now(),
  every(callback, ms) {
    const handle = setInterval(callback, ms);
    handle.unref();
    return () => clearInterval(handle);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

class SampleHistory {
  private readonly values: number[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }

  list(): number[] {
    return [...this.values];
  }

  clear(): void {
    this.values.length = 0;
  }
}

interface SampleState {
  sampledAt: number;
  cpuPercent: number | null;
  memory: HostMemory;
  processes: HostProcess[];
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export class HostMetricsSampler {
  private readonly logger: pino.Logger;
  private readonly system: HostMetricsSystem;
  private readonly timers: HostMetricsTimers;
  private readonly sampleIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private readonly diskIntervalMs: number;
  private readonly initialCpuWindowMs: number;
  private readonly processLimit: number;
  private readonly cpuHistory: SampleHistory;
  private readonly memoryHistory: SampleHistory;
  private readonly agentIdCache: AgentIdCache = new Map();

  private cancelInterval: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private sampling = false;
  private lastRequestAt = 0;
  private cpuTimes: CpuTimes | null = null;
  private state: SampleState | null = null;
  private disks: HostDisk[] = [];
  private disksSampledAt: number | null = null;
  private osLabel: string | null = null;
  private mainVolumeName: string | null = null;

  constructor(options: HostMetricsSamplerOptions) {
    this.logger = options.logger.child({ module: "host-metrics" });
    this.system = options.system ?? createNodeHostMetricsSystem();
    this.timers = options.timers ?? nodeTimers;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 2_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.diskIntervalMs = options.diskIntervalMs ?? 30_000;
    this.initialCpuWindowMs = options.initialCpuWindowMs ?? 200;
    this.processLimit = options.processLimit ?? 40;
    const historyLength = options.historyLength ?? 300;
    this.cpuHistory = new SampleHistory(historyLength);
    this.memoryHistory = new SampleHistory(historyLength);
  }

  async getSnapshot(): Promise<HostMetricsSnapshot> {
    this.lastRequestAt = this.timers.now();
    if (!this.cancelInterval) {
      this.starting ??= this.start().finally(() => {
        this.starting = null;
      });
    }
    if (this.starting) await this.starting;
    return this.buildSnapshot();
  }

  isRunning(): boolean {
    return this.cancelInterval !== null;
  }

  dispose(): void {
    this.stop();
  }

  private async start(): Promise<void> {
    this.cancelInterval = this.timers.every(() => this.tick(), this.sampleIntervalMs);
    this.cpuTimes = readCpuTimes(this.system.os);
    this.sampling = true;
    try {
      await this.loadStaticInfo();
      await Promise.all([this.sample(), this.timers.sleep(this.initialCpuWindowMs)]);
      this.recordCpu();
    } finally {
      this.sampling = false;
    }
  }

  private stop(): void {
    this.cancelInterval?.();
    this.cancelInterval = null;
    this.cpuTimes = null;
    this.state = null;
    this.disksSampledAt = null;
    this.cpuHistory.clear();
    this.memoryHistory.clear();
    this.agentIdCache.clear();
  }

  private tick(): void {
    if (this.timers.now() - this.lastRequestAt >= this.idleTimeoutMs) {
      this.stop();
      return;
    }
    if (this.sampling) return;
    this.sampling = true;
    void this.sample()
      .then(() => this.recordCpu())
      .finally(() => {
        this.sampling = false;
      });
  }

  private async loadStaticInfo(): Promise<void> {
    const input = { system: this.system, logger: this.logger };
    this.osLabel ??= await readOsLabel(input);
    if (this.system.platform === "darwin" && this.mainVolumeName === null) {
      this.mainVolumeName = await readDarwinMainVolumeName(this.system);
    }
  }

  private async sample(): Promise<void> {
    const input = { system: this.system, logger: this.logger };
    const now = this.timers.now();
    const diskDue =
      this.disksSampledAt === null || now - this.disksSampledAt >= this.diskIntervalMs;
    const [memory, processes, disks] = await Promise.all([
      collectMemory(input),
      this.collectProcesses(),
      diskDue ? collectDisks({ ...input, mainVolumeName: this.mainVolumeName }) : null,
    ]);
    if (!this.cancelInterval) return;
    if (disks) {
      this.disks = disks;
      this.disksSampledAt = now;
    }
    this.state = {
      sampledAt: this.timers.now(),
      cpuPercent: this.state?.cpuPercent ?? null,
      memory,
      processes,
    };
    if (memory.totalBytes > 0) {
      this.memoryHistory.push(roundTenth((memory.usedBytes / memory.totalBytes) * 100));
    }
  }

  private recordCpu(): void {
    if (!this.cancelInterval || !this.state || !this.cpuTimes) return;
    const current = readCpuTimes(this.system.os);
    const percent = cpuPercentBetween(this.cpuTimes, current);
    this.cpuTimes = current;
    const rounded = percent === null ? null : roundTenth(percent);
    this.state.cpuPercent = rounded;
    if (rounded !== null) this.cpuHistory.push(rounded);
  }

  private async collectProcesses(): Promise<HostProcess[]> {
    const input = { system: this.system, logger: this.logger };
    const allRows = await collectProcessRows(input);
    const rows = selectTopProcesses(allRows, this.processLimit);
    const agentIds = await resolveAgentIds({ ...input, cache: this.agentIdCache, allRows, rows });
    return rows.map((row) => ({
      pid: row.pid,
      name: row.name,
      cpuPercent: row.cpuPercent,
      memoryBytes: row.memoryBytes,
      agentId: agentIds.get(row.pid) ?? null,
    }));
  }

  private buildSnapshot(): HostMetricsSnapshot {
    const hostOs = this.system.os;
    const cpus = hostOs.cpus();
    const state = this.state;
    const totalBytes = hostOs.totalmem();
    return {
      sampledAt: new Date(state?.sampledAt ?? this.timers.now()).toISOString(),
      sampleIntervalMs: this.sampleIntervalMs,
      hostname: hostOs.hostname(),
      platform: this.system.platform,
      osLabel: this.osLabel ?? `${hostOs.type()} ${hostOs.release()}`,
      arch: hostOs.arch(),
      uptimeSeconds: hostOs.uptime(),
      cpu: {
        model: cpus[0]?.model ?? "",
        cores: cpus.length,
        percent: state?.cpuPercent ?? null,
      },
      memory: state?.memory ?? { totalBytes, usedBytes: 0, pressure: null },
      disks: this.disks,
      history: {
        cpuPercent: this.cpuHistory.list(),
        memoryPercent: this.memoryHistory.list(),
      },
      processes: state?.processes ?? [],
    };
  }
}
