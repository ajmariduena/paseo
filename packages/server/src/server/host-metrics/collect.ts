import path from "node:path";
import type pino from "pino";
import type { HostDisk, HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import {
  parseDarwinPressureLevel,
  parseDf,
  parseOsReleasePrettyName,
  parseProcEnviron,
  parseProcMeminfo,
  parsePs,
  parsePsEnvironment,
  parseVmStatUsedBytes,
  selectDisks,
  type PsRow,
} from "./parse.js";
import type { HostMetricsSystem, HostOs } from "./system.js";

export type HostMemory = HostMetricsSnapshot["memory"];

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface CollectInput {
  system: HostMetricsSystem;
  logger: pino.Logger;
}

export function readCpuTimes(hostOs: HostOs): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of hostOs.cpus()) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

export function cpuPercentBetween(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total;
  if (total <= 0) return null;
  const busy = total - (current.idle - previous.idle);
  return Math.min(100, Math.max(0, (busy / total) * 100));
}

async function readDarwinMemory(
  system: HostMetricsSystem,
  totalBytes: number,
): Promise<HostMemory> {
  const [vmStat, pressureLevel] = await Promise.all([
    system.run("vm_stat", []),
    system.run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(() => ""),
  ]);
  const usedBytes = parseVmStatUsedBytes(vmStat);
  if (usedBytes === null) throw new Error("vm_stat output is missing page counts");
  return {
    totalBytes,
    usedBytes: Math.min(usedBytes, totalBytes),
    pressure: parseDarwinPressureLevel(pressureLevel),
  };
}

async function readLinuxMemory(system: HostMetricsSystem, totalBytes: number): Promise<HostMemory> {
  const parsed = parseProcMeminfo(await system.readFile("/proc/meminfo"));
  if (!parsed) throw new Error("/proc/meminfo is missing MemTotal or MemAvailable");
  return {
    totalBytes,
    usedBytes: Math.min(parsed.usedBytes, totalBytes),
    pressure: parsed.pressure,
  };
}

export async function collectMemory({ system, logger }: CollectInput): Promise<HostMemory> {
  const totalBytes = system.os.totalmem();
  try {
    if (system.platform === "darwin") return await readDarwinMemory(system, totalBytes);
    if (system.platform === "linux") return await readLinuxMemory(system, totalBytes);
  } catch (error) {
    logger.debug({ err: error }, "Host memory sampling fell back to os.freemem");
  }
  return { totalBytes, usedBytes: totalBytes - system.os.freemem(), pressure: null };
}

export async function readDarwinMainVolumeName(system: HostMetricsSystem): Promise<string | null> {
  try {
    const entries = await system.readDir("/Volumes");
    for (const entry of entries) {
      const target = await system.readLink(path.posix.join("/Volumes", entry)).catch(() => null);
      if (target === "/") return entry;
    }
  } catch {
    return null;
  }
  return null;
}

async function statfsRootDisk(system: HostMetricsSystem): Promise<HostDisk[]> {
  const stats = await system.statfs("/");
  const totalBytes = stats.blocks * stats.bsize;
  const usedBytes = Math.max(0, totalBytes - stats.bavail * stats.bsize);
  return [{ mount: "/", name: "/", totalBytes, usedBytes }];
}

export async function collectDisks(
  input: CollectInput & { mainVolumeName: string | null },
): Promise<HostDisk[]> {
  const { system, logger } = input;
  try {
    if (system.platform === "darwin" || system.platform === "linux") {
      const rows = parseDf(await system.run("df", ["-kP"]));
      const disks = selectDisks({
        rows,
        platform: system.platform,
        mainVolumeName: input.mainVolumeName,
      });
      if (disks.length > 0) return disks;
    }
  } catch (error) {
    logger.debug({ err: error }, "Host disk sampling fell back to statfs");
  }
  try {
    return await statfsRootDisk(system);
  } catch (error) {
    logger.debug({ err: error }, "Host disk statfs failed");
    return [];
  }
}

export async function collectProcessRows({ system, logger }: CollectInput): Promise<PsRow[]> {
  if (system.platform !== "darwin" && system.platform !== "linux") return [];
  try {
    const output = await system.run("ps", ["-ww", "-axo", "pid=,ppid=,pcpu=,rss=,comm="]);
    return parsePs(output, system.platform);
  } catch (error) {
    logger.debug({ err: error }, "Host process sampling failed");
    return [];
  }
}

interface CachedAgent {
  name: string;
  agentId: string | null;
}

export type AgentIdCache = Map<number, CachedAgent>;

async function lookupAgentIds(
  system: HostMetricsSystem,
  pids: number[],
): Promise<Map<number, string | null>> {
  if (system.platform === "linux") {
    const entries = await Promise.all(
      pids.map(async (pid) => {
        const environ = await system.readFile(`/proc/${pid}/environ`).catch(() => "");
        return [pid, parseProcEnviron(environ)] as const;
      }),
    );
    return new Map(entries);
  }
  const output = await system.run("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")]);
  const found = parsePsEnvironment(output);
  return new Map(pids.map((pid) => [pid, found.get(pid) ?? null]));
}

export interface ResolveAgentIdsInput extends CollectInput {
  cache: AgentIdCache;
  allRows: PsRow[];
  rows: PsRow[];
}

export async function resolveAgentIds(
  input: ResolveAgentIdsInput,
): Promise<Map<number, string | null>> {
  const { system, logger, cache, allRows, rows } = input;
  const livePids = new Set(allRows.map((row) => row.pid));
  for (const pid of cache.keys()) {
    if (!livePids.has(pid)) cache.delete(pid);
  }
  // A cached entry under a different name means the pid was reused by another process.
  const missing = rows.filter((row) => cache.get(row.pid)?.name !== row.name);
  const canReadEnvironment = system.platform === "darwin" || system.platform === "linux";
  if (missing.length > 0 && canReadEnvironment) {
    try {
      const found = await lookupAgentIds(
        system,
        missing.map((row) => row.pid),
      );
      for (const row of missing) {
        cache.set(row.pid, { name: row.name, agentId: found.get(row.pid) ?? null });
      }
    } catch (error) {
      logger.debug({ err: error }, "Host process agent lookup failed");
    }
  }
  return new Map(rows.map((row) => [row.pid, cache.get(row.pid)?.agentId ?? null]));
}

export async function readOsLabel({ system, logger }: CollectInput): Promise<string> {
  const fallback = `${system.os.type()} ${system.os.release()}`;
  try {
    if (system.platform === "darwin") {
      const version = (await system.run("sw_vers", ["-productVersion"])).trim();
      return version ? `macOS ${version}` : fallback;
    }
    if (system.platform === "linux") {
      return parseOsReleasePrettyName(await system.readFile("/etc/os-release")) ?? fallback;
    }
  } catch (error) {
    logger.debug({ err: error }, "Host OS label lookup failed");
  }
  return fallback;
}
