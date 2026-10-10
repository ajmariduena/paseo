import { readdir, readFile, readlink, statfs } from "node:fs/promises";
import os from "node:os";
import { execCommand } from "../../utils/spawn.js";

export type HostOs = Pick<
  typeof os,
  "cpus" | "totalmem" | "freemem" | "hostname" | "arch" | "uptime" | "type" | "release"
>;

export interface HostStatFs {
  bsize: number;
  blocks: number;
  bavail: number;
}

export interface HostMetricsSystem {
  platform: NodeJS.Platform;
  os: HostOs;
  run(command: string, args: string[]): Promise<string>;
  readFile(filePath: string): Promise<string>;
  readDir(dirPath: string): Promise<string[]>;
  readLink(linkPath: string): Promise<string>;
  statfs(mount: string): Promise<HostStatFs>;
}

const COMMAND_TIMEOUT_MS = 2_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await execCommand(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    envOverlay: { LC_ALL: "C" },
  });
  return stdout;
}

export function createNodeHostMetricsSystem(): HostMetricsSystem {
  return {
    platform: process.platform,
    os,
    run,
    readFile: (filePath) => readFile(filePath, "utf8"),
    readDir: (dirPath) => readdir(dirPath),
    readLink: (linkPath) => readlink(linkPath),
    statfs: (mount) => statfs(mount),
  };
}
