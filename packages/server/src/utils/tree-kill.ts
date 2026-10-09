import treeKill from "tree-kill";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { execCommand } from "./spawn.js";

export interface ProcessTreeEntry {
  pid: number;
  parentPid: number;
  startedAt: string;
  exited: boolean;
}

export interface ProcessTreeAccess {
  list(): Promise<ProcessTreeEntry[]>;
  signal(pid: number, signal: NodeJS.Signals): void;
}

// A failed stop can be retried with the same runtime handle even after the root
// has exited. This is not a durable inventory across daemon restart.
const pendingProcessTrees = new WeakMap<TreeKillTarget, Map<number, ProcessTreeEntry>>();
const activeTreeStops = new WeakMap<TreeKillTarget, Promise<TerminateWithTreeKillResult>>();

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
  processTree?: ProcessTreeAccess;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";

// Injection seam: production wires terminateWithTreeKill; tests wire a fake that
// records which children were terminated as observable state.
export type ProcessTerminator = (
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

export async function terminateWithTreeKill(
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  const active = activeTreeStops.get(child);
  if (active) return active;
  if (isProcessExited(child) && !pendingProcessTrees.has(child)) {
    return "already-exited";
  }

  if ((process.platform !== "win32" || options.processTree) && child.pid && child.pid > 0) {
    const stopping = terminateTrackedProcessTree(child, child.pid, options);
    activeTreeStops.set(child, stopping);
    try {
      return await stopping;
    } finally {
      activeTreeStops.delete(child);
    }
  }

  const exitPromise = waitForProcessExit(child);
  await signalProcessTree(child, options.gracefulSignal ?? "SIGTERM");
  if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  await signalProcessTree(child, options.forceSignal ?? "SIGKILL");
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
    ? "killed"
    : "kill-timeout";
}

async function terminateTrackedProcessTree(
  child: TreeKillTarget,
  rootPid: number,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  const previous = pendingProcessTrees.get(child);
  const tracked = previous ?? new Map<number, ProcessTreeEntry>();
  const access = options.processTree ?? {
    list: () => listPosixProcesses([rootPid, ...tracked.keys()]),
    signal: (pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    },
  };
  pendingProcessTrees.set(child, tracked);

  function refresh(snapshot: ProcessTreeEntry[]): ProcessTreeEntry[] {
    const current = new Map(snapshot.map((entry) => [entry.pid, entry]));
    const remaining = new Map<number, ProcessTreeEntry>();
    for (const entry of tracked.values()) {
      const present = current.get(entry.pid);
      // Do not signal a PID whose start identity changed. A zombie cannot
      // execute code; its still-running descendants remain tracked separately.
      if (present && present.startedAt === entry.startedAt && !present.exited) {
        remaining.set(present.pid, present);
      }
    }
    // Refresh descendants during the grace period, including descendants of a
    // remembered child after the original owner has exited and it is reparented.
    const children = new Map<number, ProcessTreeEntry[]>();
    for (const entry of snapshot) {
      const siblings = children.get(entry.parentPid) ?? [];
      siblings.push(entry);
      children.set(entry.parentPid, siblings);
    }
    for (const entry of remaining.values()) {
      for (const descendant of children.get(entry.pid) ?? []) {
        if (!descendant.exited && !remaining.has(descendant.pid)) {
          tracked.set(descendant.pid, descendant);
          remaining.set(descendant.pid, descendant);
        }
      }
    }
    return [...remaining.values()];
  }

  async function inspect(): Promise<ProcessTreeEntry[]> {
    return refresh(await access.list());
  }

  async function stopPhase(signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + Math.max(0, timeoutMs);
    const signalled = new Map<number, string>();
    do {
      const remaining = await inspect();
      if (remaining.length === 0) return true;
      // Children first, while their parent can still reap them. Keep their
      // identities through both phases; parent exit is not tree exit.
      for (const entry of remaining.toReversed()) {
        if (signalled.get(entry.pid) === entry.startedAt) continue;
        try {
          access.signal(entry.pid, signal);
          signalled.set(entry.pid, entry.startedAt);
        } catch (error) {
          if (!isNoSuchProcess(error)) throw error;
        }
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(50, remainingMs));
    } while (performance.now() < deadline);
    return (await inspect()).length === 0;
  }

  try {
    if (tracked.size === 0) {
      const snapshot = await access.list();
      const root = snapshot.find((entry) => entry.pid === rootPid);
      if (!root || root.exited) {
        // A prior inspection failure left the tree unknown. Root exit cannot
        // turn that missing inventory into proof that its children stopped.
        if (previous) return "kill-timeout";
        pendingProcessTrees.delete(child);
        return "already-exited";
      }
      tracked.set(root.pid, root);
      refresh(snapshot);
    }
    if (await stopPhase(options.gracefulSignal ?? "SIGTERM", options.gracefulTimeoutMs)) {
      pendingProcessTrees.delete(child);
      return "terminated";
    }
    options.onForceSignal?.();
    if (await stopPhase(options.forceSignal ?? "SIGKILL", options.forceTimeoutMs ?? 1000)) {
      pendingProcessTrees.delete(child);
      return "killed";
    }
    return "kill-timeout";
  } catch {
    // Incomplete process inspection or denied signals cannot certify exit.
    return "kill-timeout";
  }
}

async function listPosixProcesses(roots: number[]): Promise<ProcessTreeEntry[]> {
  const { stdout, stderr } = await execCommand(
    "ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "stat="],
    { envOverlay: { LC_ALL: "C", TZ: "UTC" }, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (stderr.trim()) throw new Error("Process inventory reported an error");
  const entries = stdout
    .trimEnd()
    .split("\n")
    .map((line): ProcessTreeEntry => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(\S+)\s*$/.exec(
          line,
        );
      if (!match) throw new Error("Incomplete process inventory");
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        startedAt: match[3]!,
        exited: /^[ZX]/.test(match[4]!),
      };
    });
  if (!entries.some((entry) => entry.pid === process.pid)) {
    throw new Error("Process inventory is missing its caller");
  }
  if (process.platform !== "linux") return entries;

  // ps lstart has second precision and depends on wall-clock conversion. Read
  // kernel start ticks for this tree only, avoiding a /proc read for every
  // unrelated process on a busy host.
  const relevant = new Set(roots);
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.parentPid, siblings);
  }
  for (const pid of relevant) {
    for (const descendant of children.get(pid) ?? []) relevant.add(descendant);
  }
  const identified: ProcessTreeEntry[] = [];
  for (const entry of entries) {
    if (!relevant.has(entry.pid)) {
      identified.push(entry);
      continue;
    }
    try {
      const stat = await readFile(`/proc/${entry.pid}/stat`, "utf8");
      // comm is parenthesized and can itself contain spaces or parentheses.
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const state = fields[0];
      const parentPid = Number(fields[1]);
      const startTicks = fields[19];
      if (!state || !Number.isInteger(parentPid) || !startTicks || !/^\d+$/.test(startTicks)) {
        throw new Error("Incomplete kernel process identity");
      }
      identified.push({
        pid: entry.pid,
        parentPid,
        startedAt: `ticks:${startTicks}`,
        exited: /^[ZX]/.test(state),
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
  }
  return identified;
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    treeKill(pid, signal, (error) => {
      if (error) {
        signalDirectChild(child, signal);
      }
      resolve();
    });
  });
}

function signalDirectChild(child: TreeKillTarget, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function isProcessExited(child: TreeKillTarget): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForProcessExit(child: TreeKillTarget): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }
  if (!child.once) {
    return new Promise(() => undefined);
  }

  return new Promise((resolve) => {
    child.once?.("exit", resolve);
  });
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
