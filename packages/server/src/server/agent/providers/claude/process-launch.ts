import type { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { spawnProcess } from "../../../../utils/spawn.js";

export interface ClaudeProcessLaunch {
  child: ChildProcess;
  command: string;
  readonly killed: boolean;
  ready: Promise<void>;
  start(): Promise<void>;
}

interface GatedClaudeLaunchOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  strategy?: "replace" | "supervise";
}

const MAX_LAUNCH_BYTES = 8 * 1024 * 1024;

// This bootstrap receives no provider environment or arguments until registration
// is durable. Keep it self-contained: resolving modules in the workspace could
// execute user code before the gate opens.
const BOOTSTRAP = String.raw`
const { Socket } = require('node:net');
const { spawn } = require('node:child_process');
const { accessSync, constants, statSync } = require('node:fs');
const { resolve } = require('node:path');
const strategy = process.argv[1];
const control = new Socket({ fd: 3 });
let size = 0;
const chunks = [];
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
let target = null;
let stopping = false;
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
    if (strategy === 'replace') {
      // env uses execvp: preserve PATH lookup and executable script wrappers,
      // including the shell fallback that direct execve does not provide.
      process.execve('/usr/bin/env', ['env', '--', command, ...args], env);
      fail();
    } else {
      // macOS protected intermediaries strip DYLD_* values. Native spawn passes
      // the provider's environment directly, with this registered root retained
      // until its child exits. Its standard streams go straight to the SDK.
      const watchTarget = (child, allowScriptFallback) => {
        target = child;
        child.once('error', (error) => {
          if (!allowScriptFallback || error.code !== 'ENOEXEC') return fail();
          if (stopping) return process.exit(1);
          // Darwin's posix_spawn does not provide execvp's ENOEXEC shell fallback.
          // Resolve PATH before passing an exact file to sh: sh itself can prefer
          // a same-named file in cwd. Never concatenate provider arguments into code.
          let script = command.includes('/') ? resolve(command) : null;
          if (!script) {
            for (const directory of (env.PATH ?? '/usr/bin:/bin').split(':')) {
              const candidate = resolve(directory || '.', command);
              try {
                accessSync(candidate, constants.X_OK);
                if (statSync(candidate).isFile()) { script = candidate; break; }
              } catch {}
            }
          }
          if (!script) return fail();
          watchTarget(spawn('/bin/sh', [script, ...args], { env, stdio: 'inherit', shell: false }), false);
        });
        child.once('exit', (code, signal) => {
          for (const name of signals) process.removeAllListeners(name);
          if (signal) process.kill(process.pid, signal);
          process.exit(code ?? 1);
        });
      };
      watchTarget(spawn(command, args, { env, stdio: 'inherit', shell: false }), true);
      control.destroy();
      chunks.length = 0;
    }
  } catch { fail(); }
});
if (strategy === 'replace' && typeof process.execve !== 'function') fail();
if (strategy === 'supervise') {
  // Tree shutdown signals descendants itself. Relaying its OS signal would send
  // the provider a second signal and can interrupt its cleanup handler.
  for (const signal of signals) process.on(signal, () => {
    stopping = true;
    if (!target) process.exit(0);
  });
  process.on('message', (message) => {
    if (message.kind !== 'signal') return;
    stopping = true;
    if (!target) process.exit(0);
    target.kill(message.signal);
  });
}
control.write('ready\n');
`;

export function spawnGatedClaudeProcess(options: GatedClaudeLaunchOptions): ClaudeProcessLaunch {
  const strategy = options.strategy ?? (process.platform === "darwin" ? "supervise" : "replace");
  if (strategy === "replace" && (!("execve" in process) || typeof process.execve !== "function")) {
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
  const child = spawnProcess(process.execPath, ["--no-warnings", "-e", BOOTSTRAP, "--", strategy], {
    cwd: options.cwd,
    // The target's NODE_OPTIONS, loader hooks and credentials arrive only in the
    // private control channel. The helper itself runs with a fixed environment.
    env: { ELECTRON_RUN_AS_NODE: "1" },
    envMode: "internal",
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe", "pipe", ...(strategy === "supervise" ? ["ipc" as const] : [])],
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
  let signalRequested = false;
  if (strategy === "supervise") {
    const signalBootstrap = child.kill.bind(child);
    child.kill = (signal) => {
      // Before dispatch only the trusted bootstrap exists. After dispatch SDK
      // signals go over IPC; registry shutdown uses OS signals for the full tree.
      if (!started || signal === 0) return signalBootstrap(signal);
      if (!child.connected || child.exitCode !== null || child.signalCode !== null) return false;
      child.send!({ kind: "signal", signal: signal ?? "SIGTERM" }, (error: Error | null) => {
        if (error) child.emit("error", error);
      });
      signalRequested = true;
      return true;
    };
  }
  return {
    child,
    command: options.command,
    get killed() {
      return signalRequested || child.killed;
    },
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
