import type { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { spawnProcess } from "../../../../utils/spawn.js";

export interface ClaudeProcessLaunch {
  child: ChildProcess;
  command: string;
  ready: Promise<void>;
  start(): Promise<void>;
}

interface GatedClaudeLaunchOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

const MAX_LAUNCH_BYTES = 8 * 1024 * 1024;

// This bootstrap receives no provider environment or arguments until registration
// is durable. execve keeps its recorded PID/birth identity and leaves no resident
// intermediary. Keep it self-contained: resolving modules in the workspace could
// execute user code before the gate opens.
const BOOTSTRAP = String.raw`
const { Socket } = require('node:net');
const control = new Socket({ fd: 3 });
let size = 0;
const chunks = [];
function fail() {
  process.stderr.write('Claude process launch failed before exec\n');
  process.exit(1);
}
control.on('error', fail);
control.on('data', (chunk) => {
  size += chunk.length;
  if (size > 8 * 1024 * 1024) fail();
  chunks.push(chunk);
});
control.on('end', () => {
  if (size === 0) process.exit(0);
  try {
    const { command, args, env } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // env uses execvp: preserve PATH lookup and executable script wrappers,
    // including the shell fallback that direct execve does not provide.
    process.execve('/usr/bin/env', ['env', '--', command, ...args], env);
    fail();
  } catch { fail(); }
});
if (typeof process.execve !== 'function') fail();
control.write('ready\n');
`;

export function spawnGatedClaudeProcess(options: GatedClaudeLaunchOptions): ClaudeProcessLaunch {
  if (!("execve" in process) || typeof process.execve !== "function") {
    throw new Error("Durable Claude launch requires a runtime with process.execve (Node 22.15+)");
  }
  const values = [
    options.command,
    ...options.args,
    ...Object.keys(options.env),
    ...Object.values(options.env),
  ];
  if (values.some((value) => value?.includes("\0")))
    throw new Error("Invalid null byte in Claude launch");
  const packet = JSON.stringify({ command: options.command, args: options.args, env: options.env });
  if (Buffer.byteLength(packet) > MAX_LAUNCH_BYTES)
    throw new Error("Claude launch configuration exceeds its byte limit");
  const child = spawnProcess(process.execPath, ["--no-warnings", "-e", BOOTSTRAP], {
    cwd: options.cwd,
    // The target's NODE_OPTIONS, loader hooks and credentials arrive only in the
    // private control channel. The helper itself runs with a fixed environment.
    env: { ELECTRON_RUN_AS_NODE: "1" },
    envMode: "internal",
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    shell: false,
  });
  const control = child.stdio[3];
  if (!(control instanceof Duplex)) throw new Error("Claude launch control stream is unavailable");
  const ready = new Promise<void>((resolve, reject) => {
    let acknowledgement = "";
    control.on("data", (chunk: Buffer) => {
      acknowledgement += chunk.toString("utf8");
      if (!"ready\n".startsWith(acknowledgement))
        reject(new Error("Invalid Claude launch acknowledgement"));
      else if (acknowledgement === "ready\n") resolve();
    });
    control.on("error", reject);
    child.once("error", reject);
    child.once("exit", () => {
      reject(new Error("Claude launch exited before its registration gate was ready"));
      control.destroy();
    });
  });
  let started: Promise<void> | null = null;
  return {
    child,
    command: options.command,
    ready,
    start() {
      if (!started) {
        started = ready.then(
          () =>
            new Promise<void>((resolve, reject) => {
              control.once("error", reject);
              control.end(packet, (error?: Error | null) => {
                if (error) reject(error);
                else resolve();
              });
            }),
        );
      }
      return started;
    },
  };
}
