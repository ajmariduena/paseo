import path from "node:path";
import type { HostDisk, HostMemoryPressure } from "@getpaseo/protocol/host-metrics/types";

export interface ParsedMemory {
  usedBytes: number;
  pressure: HostMemoryPressure | null;
}

export interface DfRow {
  filesystem: string;
  mount: string;
  totalBytes: number;
  availableBytes: number;
}

export interface PsRow {
  pid: number;
  ppid: number;
  cpuPercent: number;
  memoryBytes: number;
  name: string;
}

const KIB = 1024;

export function parseVmStatUsedBytes(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  if (!pageSize) return null;
  const pages = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line);
    if (match) pages.set(match[1].trim(), Number(match[2]));
  }
  const active = pages.get("Pages active");
  const wired = pages.get("Pages wired down");
  const compressed = pages.get("Pages occupied by compressor");
  if (active === undefined || wired === undefined || compressed === undefined) return null;
  return (active + wired + compressed) * Number(pageSize);
}

export function parseDarwinPressureLevel(output: string): HostMemoryPressure | null {
  switch (output.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return null;
  }
}

export function parseProcMeminfo(output: string): ParsedMemory | null {
  const fields = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match) fields.set(match[1], Number(match[2]) * KIB);
  }
  const total = fields.get("MemTotal");
  const available = fields.get("MemAvailable");
  if (total === undefined || available === undefined || total === 0) return null;
  const availableRatio = available / total;
  let pressure: HostMemoryPressure = "normal";
  if (availableRatio < 0.1) pressure = "critical";
  else if (availableRatio < 0.2) pressure = "warn";
  return { usedBytes: total - available, pressure };
}

export function parseOsReleasePrettyName(output: string): string | null {
  const match = /^PRETTY_NAME=(.*)$/m.exec(output);
  if (!match) return null;
  const name = match[1].trim().replace(/^["']|["']$/g, "");
  return name.length > 0 ? name : null;
}

export function parseDf(output: string): DfRow[] {
  const rows: DfRow[] = [];
  for (const line of output.split("\n").slice(1)) {
    const match = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:\d+%|-)\s+(.+)$/.exec(line.trimEnd());
    if (!match) continue;
    rows.push({
      filesystem: match[1],
      mount: match[5],
      totalBytes: Number(match[2]) * KIB,
      availableBytes: Number(match[4]) * KIB,
    });
  }
  return rows;
}

const LINUX_PSEUDO_FILESYSTEMS = new Set([
  "tmpfs",
  "devtmpfs",
  "udev",
  "overlay",
  "shm",
  "none",
  "squashfs",
  "efivarfs",
  "cgroup",
  "cgroup2",
  "proc",
  "sysfs",
]);

const LINUX_SYSTEM_MOUNT_ROOTS = ["/run", "/sys", "/proc", "/dev", "/boot/efi", "/snap"];

function isUnderMount(mount: string, root: string): boolean {
  return mount === root || mount.startsWith(`${root}/`);
}

function isLinuxUserDisk(row: DfRow): boolean {
  if (LINUX_PSEUDO_FILESYSTEMS.has(row.filesystem)) return false;
  if (row.filesystem.startsWith("/dev/loop")) return false;
  // Containers bind-mount single files such as /etc/hosts from the host disk.
  if (row.mount.startsWith("/etc/")) return false;
  return !LINUX_SYSTEM_MOUNT_ROOTS.some((root) => isUnderMount(row.mount, root));
}

const DARWIN_DATA_VOLUME = "/System/Volumes/Data";

function isDarwinUserDisk(row: DfRow): boolean {
  const isDevice = row.filesystem.startsWith("/dev/");
  const isUserMount = row.mount.startsWith("/Volumes/");
  if (!isDevice && !isUserMount) return false;
  if (row.mount.startsWith("/System/Volumes/")) return row.mount === DARWIN_DATA_VOLUME;
  return !row.mount.startsWith("/Library/Developer/CoreSimulator/");
}

export interface SelectDisksInput {
  rows: DfRow[];
  platform: NodeJS.Platform;
  mainVolumeName: string | null;
}

interface SourcedDisk {
  filesystem: string;
  disk: HostDisk;
}

function toDisk(row: DfRow, mount: string, name: string): SourcedDisk {
  // APFS volumes share their container's free space, so total - available also counts the
  // sibling system volumes (VM, Preboot) that df's "Used" column leaves out.
  const usedBytes = Math.max(0, row.totalBytes - row.availableBytes);
  return {
    filesystem: row.filesystem,
    disk: { mount, name, totalBytes: row.totalBytes, usedBytes },
  };
}

function selectDarwinDisks(rows: DfRow[], mainVolumeName: string | null): SourcedDisk[] {
  const candidates = rows.filter(isDarwinUserDisk);
  const hasDataVolume = candidates.some((row) => row.mount === DARWIN_DATA_VOLUME);
  const mainName = mainVolumeName ?? "System";
  const disks: SourcedDisk[] = [];
  for (const row of candidates) {
    if (row.mount === "/" && hasDataVolume) continue;
    if (row.mount === DARWIN_DATA_VOLUME || row.mount === "/") {
      disks.push(toDisk(row, "/", mainName));
      continue;
    }
    disks.push(toDisk(row, row.mount, path.posix.basename(row.mount)));
  }
  return disks;
}

function selectLinuxDisks(rows: DfRow[]): SourcedDisk[] {
  return rows.filter(isLinuxUserDisk).map((row) => toDisk(row, row.mount, row.mount));
}

export function selectDisks(input: SelectDisksInput): HostDisk[] {
  const sized = input.rows.filter((row) => row.totalBytes > 0);
  const sourced =
    input.platform === "darwin"
      ? selectDarwinDisks(sized, input.mainVolumeName)
      : selectLinuxDisks(sized);
  const ordered = [
    ...sourced.filter((entry) => entry.disk.mount === "/"),
    ...sourced.filter((entry) => entry.disk.mount !== "/"),
  ];
  const seen = new Set<string>();
  const disks: HostDisk[] = [];
  for (const { filesystem, disk } of ordered) {
    const key = `${filesystem}|${disk.totalBytes}|${disk.usedBytes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    disks.push(disk);
  }
  return disks;
}

export function parsePs(output: string, platform: NodeJS.Platform): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(.+)$/.exec(line.trimEnd());
    if (!match) continue;
    const command = match[5];
    // macOS reports the executable path; Linux reports the task name, which may contain "/".
    const name = platform === "darwin" ? path.posix.basename(command) : command;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3].replace(",", ".")),
      memoryBytes: Number(match[4]) * KIB,
      name,
    });
  }
  return rows;
}

export function selectTopProcesses(rows: PsRow[], limit: number): PsRow[] {
  const byCpu = rows.toSorted((a, b) => b.cpuPercent - a.cpuPercent).slice(0, limit);
  const byMemory = rows.toSorted((a, b) => b.memoryBytes - a.memoryBytes).slice(0, limit);
  const merged = new Map<number, PsRow>();
  for (const row of [...byCpu, ...byMemory]) merged.set(row.pid, row);
  return [...merged.values()].toSorted(
    (a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes,
  );
}

const AGENT_ID_PATTERN = /(?:^|\s)PASEO_AGENT_ID=(\S+)/;

export function parsePsEnvironment(output: string): Map<number, string | null> {
  const agentIds = new Map<number, string | null>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    agentIds.set(Number(match[1]), AGENT_ID_PATTERN.exec(match[2])?.[1] ?? null);
  }
  return agentIds;
}

export function parseProcEnviron(environ: string): string | null {
  const prefix = "PASEO_AGENT_ID=";
  const entry = environ.split("\0").find((item) => item.startsWith(prefix));
  if (!entry) return null;
  const agentId = entry.slice(prefix.length);
  return agentId.length > 0 ? agentId : null;
}
