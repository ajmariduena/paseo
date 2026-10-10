import treeKill from "tree-kill";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { execCommand } from "./spawn.js";

export interface ProcessTreeEntry {
  pid: number;
  parentPid: number;
  startedAt: string;
  exited: boolean;
}

export const ProcessTreeCheckpointSchema = z
  .object({
    bootId: z.string().min(1),
    entries: z
      .array(
        z.object({
          pid: z.number().int().positive(),
          parentPid: z.number().int().nonnegative(),
          startedAt: z.string().min(1),
          exited: z.boolean(),
        }),
      )
      .min(1)
      .max(4096),
  })
  .refine(
    (tree) => new Set(tree.entries.map((entry) => entry.pid)).size === tree.entries.length,
    "Process checkpoint contains duplicate PIDs",
  );

export type ProcessTreeCheckpoint = z.infer<typeof ProcessTreeCheckpointSchema>;

export interface ProcessTreeAccess {
  bootId?(): Promise<string>;
  list(): Promise<ProcessTreeEntry[]>;
  signal(pid: number, signal: NodeJS.Signals): void;
}

// A failed stop can be retried with the same runtime handle even after the root
// has exited. This is not a durable inventory across daemon restart.
const pendingProcessTrees = new WeakMap<TreeKillTarget, Map<number, ProcessTreeEntry>>();
const activeTreeStops = new WeakMap<TreeKillTarget, Promise<TerminateWithTreeKillResult>>();
const confirmedProcessTrees = new WeakSet<TreeKillTarget>();

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

export interface TerminateWithTreeKillOptions {
  /** Root exit without an observed tree cannot certify managed writer shutdown. */
  requireTreeProof?: boolean;
  initialTree?: ProcessTreeCheckpoint;
  requireLiveRoot?: boolean;
  beforeTreeInspection?: () => Promise<void>;
  onTreeObserved?: (tree: ProcessTreeCheckpoint) => Promise<void>;
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
  onError?: (error: unknown) => void;
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
  if (confirmedProcessTrees.has(child)) return "already-exited";
  if (isProcessExited(child) && !pendingProcessTrees.has(child) && !options.initialTree) {
    if (options.requireTreeProof) {
      pendingProcessTrees.set(child, new Map());
      return "kill-timeout";
    }
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

  if (options.requireTreeProof) return "kill-timeout";

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
  const tracked =
    previous ?? new Map(options.initialTree?.entries.map((entry) => [entry.pid, entry]));
  let bootId: string | null = null;
  let needsLiveRoot = options.requireLiveRoot === true;
  const access = options.processTree ?? {
    list: () => listPosixProcesses([rootPid, ...tracked.keys()]),
    signal: (pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    },
  };
  pendingProcessTrees.set(child, tracked);

  async function inspect(): Promise<ProcessTreeEntry[]> {
    if (options.beforeTreeInspection) await options.beforeTreeInspection();
    const snapshot = await access.list();
    if (needsLiveRoot) {
      const root = snapshot.find((entry) => entry.pid === rootPid);
      if (
        !root ||
        root.exited ||
        root.startedAt !== tracked.get(rootPid)?.startedAt ||
        isProcessExited(child)
      ) {
        throw new Error("Process exited before its closing inventory");
      }
      needsLiveRoot = false;
    }
    const remaining = refreshProcessTree(tracked, snapshot);
    await publish();
    return remaining;
  }

  async function publish(): Promise<void> {
    if (options.onTreeObserved && bootId) {
      const checkpoint = ProcessTreeCheckpointSchema.parse({
        bootId,
        entries: [...tracked.values()],
      });
      await options.onTreeObserved(checkpoint);
    }
  }

  async function stopPhase(signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + Math.max(0, timeoutMs);
    const signalled = new Map<number, string>();
    do {
      const remaining = await inspect();
      if (remaining.length === 0) return true;
      // Children first, while their parent can still reap them. Keep their
      // identities through both phases; parent exit is not tree exit.
      for (let index = remaining.length - 1; index >= 0; index--) {
        const entry = remaining[index]!;
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

  async function initialize(): Promise<TerminateWithTreeKillResult | null> {
    if (options.initialTree || options.onTreeObserved) {
      bootId = await (access.bootId ?? readProcessBootId)();
      if (options.initialTree && options.initialTree.bootId !== bootId) {
        pendingProcessTrees.delete(child);
        confirmedProcessTrees.add(child);
        return "already-exited";
      }
    }
    if (tracked.size === 0) {
      if (options.beforeTreeInspection) await options.beforeTreeInspection();
      const snapshot = await access.list();
      const root = snapshot.find((entry) => entry.pid === rootPid);
      if (!root || root.exited || isProcessExited(child)) {
        // A prior inspection failure left the tree unknown. Root exit cannot
        // turn that missing inventory into proof that its children stopped.
        if (previous || options.requireTreeProof) return "kill-timeout";
        pendingProcessTrees.delete(child);
        return "already-exited";
      }
      tracked.set(root.pid, root);
      refreshProcessTree(tracked, snapshot);
      await publish();
    }
    return null;
  }

  try {
    const initialResult = await initialize();
    if (initialResult) return initialResult;
    if (await stopPhase(options.gracefulSignal ?? "SIGTERM", options.gracefulTimeoutMs)) {
      pendingProcessTrees.delete(child);
      confirmedProcessTrees.add(child);
      return "terminated";
    }
    options.onForceSignal?.();
    if (await stopPhase(options.forceSignal ?? "SIGKILL", options.forceTimeoutMs ?? 1000)) {
      pendingProcessTrees.delete(child);
      confirmedProcessTrees.add(child);
      return "killed";
    }
    return "kill-timeout";
  } catch (error) {
    // Incomplete process inspection or denied signals cannot certify exit.
    options.onError?.(error);
    return "kill-timeout";
  }
}

function refreshProcessTree(
  tracked: Map<number, ProcessTreeEntry>,
  snapshot: ProcessTreeEntry[],
): ProcessTreeEntry[] {
  const current = new Map(snapshot.map((entry) => [entry.pid, entry]));
  const remaining = new Map<number, ProcessTreeEntry>();
  for (const entry of tracked.values()) {
    const present = current.get(entry.pid);
    // Zombies cannot execute code. Remember their children independently.
    if (present && present.startedAt === entry.startedAt && !present.exited) {
      remaining.set(present.pid, present);
    }
  }
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

export async function readProcessBootId(): Promise<string> {
  let value: string;
  if (process.platform === "linux") {
    value = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
  } else if (process.platform === "darwin") {
    // bootsessionuuid identifies this boot; boottime changes with wall-clock corrections.
    const output = await execCommand("sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 5000 });
    if (output.stderr.trim()) throw new Error("Boot identity lookup reported an error");
    value = output.stdout;
  } else {
    throw new Error("Durable process tree identity is unavailable on this platform");
  }
  const uuid = value.trim().toLowerCase();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid)) {
    throw new Error("Invalid process boot identity");
  }
  return `${process.platform}:${uuid}`;
}

export async function captureProcessTree(child: TreeKillTarget): Promise<ProcessTreeCheckpoint> {
  if (!child.pid || isProcessExited(child)) throw new Error("Process exited before tree capture");
  const bootId = await readProcessBootId();
  const entries = await listPosixProcesses([child.pid]);
  const root = entries.find((entry) => entry.pid === child.pid);
  if (!root || root.exited || isProcessExited(child))
    throw new Error("Process exited during tree capture");
  const tracked = new Map([[root.pid, root]]);
  refreshProcessTree(tracked, entries);
  return ProcessTreeCheckpointSchema.parse({ bootId, entries: [...tracked.values()] });
}

export async function isProcessTreeStopped(
  checkpoint: ProcessTreeCheckpoint,
  access?: ProcessTreeAccess,
): Promise<boolean> {
  if (checkpoint.bootId !== (await (access?.bootId ?? readProcessBootId)())) return true;
  const tracked = new Map(checkpoint.entries.map((entry) => [entry.pid, entry]));
  const snapshot = access ? await access.list() : await listPosixProcesses([...tracked.keys()]);
  return refreshProcessTree(tracked, snapshot).length === 0;
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
    const identity = await readLinuxProcessEntry(entry.pid);
    if (identity) identified.push(identity);
  }
  return identified;
}

export async function readLinuxProcessEntry(
  pid: number,
  readStat: (file: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<ProcessTreeEntry | null> {
  let stat: string;
  try {
    stat = await readStat(`/proc/${pid}/stat`);
  } catch (error) {
    // Exit before open reports ENOENT; exit between open and read reports ESRCH.
    if (
      isNoSuchProcess(error) ||
      (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    )
      return null;
    throw error;
  }
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
  return { pid, parentPid, startedAt: `ticks:${startTicks}`, exited: /^[ZX]/.test(state) };
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
