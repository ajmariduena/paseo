import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { syncFilePublication, writeJsonFileAtomic } from "../atomic-file.js";
import { execCommand } from "../../utils/spawn.js";
import {
  ProcessTreeCheckpointSchema,
  isProcessTreeStopped,
  readProcessBootId,
  type ProcessTreeCheckpoint,
  type ProcessTreeAccess,
  type ProcessTerminator,
  type TreeKillTarget,
} from "../../utils/tree-kill.js";

const MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const MANAGED_PROCESS_EXIT_POLL_INTERVAL_MS = 50;
const MANAGED_PROCESS_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
// `ps -o lstart` emits a fixed-width 24-char ctime stamp, e.g. "Sat Jun 20 10:30:40 2026".
const POSIX_LSTART_WIDTH = 24;
const POSIX_LSTART_PATTERN =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

const ManagedRuntimeSchema = z.object({
  agentId: z.string().min(1),
  generationId: z.string().uuid(),
});
export type ManagedRuntime = z.infer<typeof ManagedRuntimeSchema>;

const ManagedProcessRecordSchema = z
  .object({
    id: z.string().min(1),
    owner: z.object({
      provider: z.string().min(1),
      kind: z.string().min(1),
    }),
    pid: z.number().int().positive(),
    command: z.string().min(1),
    args: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).default({}),
    identity: z.object({
      commandLine: z.string().nullable(),
      startedAt: z.string().nullable(),
    }),
    createdAt: z.string().min(1),
    runtime: ManagedRuntimeSchema.optional(),
    tree: z
      .object({
        checkpoint: ProcessTreeCheckpointSchema,
        inspectionPending: z.boolean(),
        state: z.enum(["gated", "running", "stopping", "stopped"]),
      })
      .optional(),
  })
  .refine(
    (record) =>
      record.tree?.state !== "stopped" ||
      (record.runtime !== undefined && !record.tree.inspectionPending),
    "A stop acknowledgement requires a runtime identity and completed inspection",
  );

const WindowsProcessSnapshotSchema = z.object({
  ProcessId: z.number().int().positive(),
  CommandLine: z.string().nullable().optional(),
  CreationDate: z.string().nullable().optional(),
});

export interface ManagedProcessSnapshot {
  pid: number;
  commandLine: string | null;
  startedAt: string | null;
}

export type ManagedProcessInspection =
  | { status: "alive"; snapshot: ManagedProcessSnapshot }
  | { status: "not-found" }
  | { status: "error"; error: unknown };

export interface ManagedProcessTable {
  inspect(pid: number): Promise<ManagedProcessInspection>;
}

export interface ManagedProcessCommandRunner {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface ManagedProcessOwner {
  provider: string;
  kind: string;
}

export interface ManagedProcessRecordInput {
  runtime?: ManagedRuntime;
  owner: ManagedProcessOwner;
  pid: number;
  command: string;
  args: string[];
  metadata?: Record<string, unknown>;
  processTree?: ProcessTreeCheckpoint;
  // Only a trusted bootstrap that cannot spawn work before admitLaunch().
  launchGated?: boolean;
}

export type ManagedProcessRecord = z.infer<typeof ManagedProcessRecordSchema>;

export interface ManagedProcessReapResult {
  checked: number;
  dead: number;
  mismatched: number;
  removed: number;
  terminated: number;
  errors: Array<{ id: string; message: string }>;
}

export interface ManagedProcessRegistry {
  record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord>;
  admitLaunch(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  list(options?: { includeStopped?: boolean }): Promise<ManagedProcessRecord[]>;
  /** Only after the owner's closed record, or its successor opening, is durable. */
  retireStoppedRuntime(runtime: ManagedRuntime): Promise<void>;
  reapStale(): Promise<ManagedProcessReapResult>;
}

interface ManagedProcessRegistryOptions {
  paseoHome: string;
  processTable: ManagedProcessTable;
  terminateProcess: ProcessTerminator;
  logger: Logger;
  processTree?: ProcessTreeAccess;
  syncPublication?: typeof syncFilePublication;
}

export class ManagedProcessPublicationError extends Error {
  constructor(
    readonly recordId: string,
    cause: unknown,
  ) {
    super(`Managed process registration is not durable: ${recordId}`, { cause });
    this.name = "ManagedProcessPublicationError";
  }
}

class ManagedProcessRecordMissingError extends Error {
  constructor(readonly recordId: string) {
    super(`Managed process record is missing: ${recordId}`);
    this.name = "ManagedProcessRecordMissingError";
  }
}

class ManagedProcessLaunchStateError extends Error {
  constructor(readonly recordId: string) {
    super(`Managed process launch cannot be admitted: ${recordId}`);
    this.name = "ManagedProcessLaunchStateError";
  }
}

class ManagedProcessTerminationError extends Error {
  constructor(
    readonly pid: number,
    readonly reason: "timeout" | "still_running",
  ) {
    const detail =
      reason === "timeout" ? "termination timed out" : "is still running after termination";
    super(`Managed helper ${detail}: ${pid}`);
    this.name = "ManagedProcessTerminationError";
  }
}

class ManagedProcessInspectionError extends Error {
  constructor(readonly pid: number) {
    super(`Incomplete process inspection for PID ${pid}`);
    this.name = "ManagedProcessInspectionError";
  }
}

interface ManagedProcessEntry {
  path: string;
  record: ManagedProcessRecord;
}

interface ManagedProcessInventory {
  entries: ManagedProcessEntry[];
  errors: ManagedProcessReapResult["errors"];
}

class ManagedProcessInventoryError extends Error {
  constructor(readonly errors: ManagedProcessReapResult["errors"]) {
    super(`Managed process inventory is incomplete: ${errors.map((error) => error.id).join(", ")}`);
    this.name = "ManagedProcessInventoryError";
  }
}

export function createManagedProcessRegistry(
  options: ManagedProcessRegistryOptions,
): ManagedProcessRegistry {
  return new FileBackedManagedProcessRegistry(options);
}

export function createSystemManagedProcessTable(options?: {
  platform?: NodeJS.Platform;
  commandRunner?: ManagedProcessCommandRunner;
}): ManagedProcessTable {
  return new SystemManagedProcessTable({
    platform: options?.platform ?? process.platform,
    commandRunner: options?.commandRunner ?? {
      exec: (command, args) => execCommand(command, args, { envOverlay: { LC_ALL: "C" } }),
    },
  });
}

class SystemManagedProcessTable implements ManagedProcessTable {
  private readonly platform: NodeJS.Platform;
  private readonly commandRunner: ManagedProcessCommandRunner;

  constructor(options: { platform: NodeJS.Platform; commandRunner: ManagedProcessCommandRunner }) {
    this.platform = options.platform;
    this.commandRunner = options.commandRunner;
  }

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { status: "not-found" };
    }

    try {
      return this.platform === "win32"
        ? await this.inspectWindows(pid)
        : await this.inspectPosix(pid);
    } catch (error) {
      return { status: "error", error };
    }
  }

  private async inspectPosix(pid: number): Promise<ManagedProcessInspection> {
    let stdout: string;
    try {
      ({ stdout } = await this.commandRunner.exec("ps", [
        "-ww",
        "-p",
        String(pid),
        "-o",
        "lstart=",
        "-o",
        "command=",
      ]));
    } catch (error) {
      // Only ps's empty no-match response proves absence. Usage, permission,
      // timeout and partial-output failures must retain the helper's record.
      return isNoMatchingProcessError(error) ? { status: "not-found" } : { status: "error", error };
    }

    const line = stdout.trimEnd();
    const startedAt = line.slice(0, POSIX_LSTART_WIDTH).trim();
    const commandLine = line.slice(POSIX_LSTART_WIDTH).trim();
    if (!POSIX_LSTART_PATTERN.test(startedAt) || !commandLine) {
      throw new ManagedProcessInspectionError(pid);
    }
    return {
      status: "alive",
      snapshot: {
        pid,
        commandLine: commandLine || null,
        startedAt: startedAt || null,
      },
    };
  }

  private async inspectWindows(pid: number): Promise<ManagedProcessInspection> {
    const command = [
      `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
      "if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
    ].join(" ");
    const { stdout } = await this.commandRunner.exec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { status: "not-found" };
    }

    const parsed = WindowsProcessSnapshotSchema.parse(JSON.parse(trimmed));
    return {
      status: "alive",
      snapshot: {
        pid,
        commandLine: parsed.CommandLine ?? null,
        startedAt: parsed.CreationDate ?? null,
      },
    };
  }
}

class FileBackedManagedProcessRegistry implements ManagedProcessRegistry {
  private readonly directory: string;
  private readonly processTable: ManagedProcessTable;
  private readonly terminateProcess: ProcessTerminator;
  private readonly logger: Logger;
  private readonly paseoHome: string;
  private readonly processTree?: ProcessTreeAccess;
  private readonly syncPublication: typeof syncFilePublication;
  private readonly writes = new Map<string, Promise<void>>();
  private readonly unpublished = new Map<string, ManagedProcessRecord>();

  constructor(options: ManagedProcessRegistryOptions) {
    this.paseoHome = options.paseoHome;
    this.processTree = options.processTree;
    this.syncPublication = options.syncPublication ?? syncFilePublication;
    this.directory = path.join(options.paseoHome, "runtime", "managed-processes");
    this.processTable = options.processTable;
    this.terminateProcess = options.terminateProcess;
    this.logger = options.logger.child({ module: "managed-processes" });
  }

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    if (input.runtime && !input.processTree) throw new ManagedProcessInspectionError(input.pid);
    if (input.launchGated && input.processTree?.entries.length !== 1)
      throw new ManagedProcessInspectionError(input.pid);
    const inspection = input.processTree ? null : await this.processTable.inspect(input.pid);
    const snapshot = inspection?.status === "alive" ? inspection.snapshot : null;
    const record: ManagedProcessRecord = {
      id: randomUUID(),
      owner: input.owner,
      pid: input.pid,
      command: input.command,
      args: input.args,
      metadata: input.metadata ?? {},
      identity: {
        commandLine: snapshot?.commandLine ?? null,
        startedAt: snapshot?.startedAt ?? null,
      },
      createdAt: new Date().toISOString(),
      runtime: input.runtime,
      ...(input.processTree
        ? {
            tree: {
              checkpoint: input.processTree,
              inspectionPending: false,
              state: input.launchGated ? "gated" : "running",
            },
          }
        : {}),
    };

    const validated = ManagedProcessRecordSchema.parse(record);
    if (
      validated.tree &&
      !validated.tree.checkpoint.entries.some((entry) => entry.pid === validated.pid)
    ) {
      throw new ManagedProcessInspectionError(validated.pid);
    }
    try {
      await this.publish(validated);
    } catch (error) {
      // The caller must retain this identity even when no file reached disk.
      throw new ManagedProcessPublicationError(validated.id, error);
    }
    return validated;
  }

  async admitLaunch(id: string): Promise<void> {
    return this.serialize(id, async () => {
      await this.repairPublication(id);
      const record = await this.readRecord(id);
      if (!record) throw new ManagedProcessRecordMissingError(id);
      if (
        !record.tree ||
        record.tree.inspectionPending ||
        !["gated", "running"].includes(record.tree.state)
      )
        throw new ManagedProcessLaunchStateError(id);
      // A crash after this publication may have dispatched work. Cold recovery
      // must no longer treat an exited root as an unused bootstrap.
      await this.publish({ ...record, tree: { ...record.tree, state: "running" } });
    });
  }

  async remove(id: string): Promise<void> {
    return this.serialize(id, async () => {
      await this.repairPublication(id);
      const record = await this.readRecord(id);
      if (!record) return;
      await this.confirmProcessExited(record);
      await this.completeStop(record);
    });
  }

  async stop(id: string): Promise<void> {
    return this.serialize(id, async () => {
      await this.repairPublication(id);
      const stored = await this.readRecord(id);
      if (!stored) throw new ManagedProcessRecordMissingError(id);
      let record = stored;
      if (!record.tree) throw new ManagedProcessInspectionError(record.pid);
      if (record.tree.state === "stopped") {
        // Re-acknowledge publication after restart without inspecting or signalling reused PIDs.
        await this.publish(record);
        return;
      }
      const bootId = await (this.processTree?.bootId ?? readProcessBootId)();
      if (record.tree.checkpoint.bootId !== bootId) {
        await this.completeStop(record);
        return;
      }
      // Before admission no provider can run or create descendants, so a failed
      // inspection cannot lose a child inventory. The gated marker survives restart.
      if (record.tree.inspectionPending && record.tree.state !== "gated")
        throw new ManagedProcessInspectionError(record.pid);
      const initialTree = record.tree.checkpoint;
      const result = await this.terminateProcess(createPidTarget(record.pid), {
        requireTreeProof: true,
        initialTree,
        requireLiveRoot: record.tree.state === "running",
        processTree: this.processTree,
        gracefulTimeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        forceTimeoutMs: MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS,
        beforeTreeInspection: async () => {
          record = {
            ...record,
            tree: { ...record.tree!, inspectionPending: true },
          };
          await this.publish(record);
        },
        onTreeObserved: async (checkpoint) => {
          record = { ...record, tree: { checkpoint, inspectionPending: false, state: "stopping" } };
          await this.publish(record);
        },
      });
      if (result === "kill-timeout")
        throw new ManagedProcessTerminationError(record.pid, "timeout");
      await this.confirmProcessExited(record);
      await this.completeStop(record);
    });
  }

  private async completeStop(record: ManagedProcessRecord): Promise<void> {
    if (record.runtime && record.tree) {
      await this.publish({
        ...record,
        tree: { ...record.tree, inspectionPending: false, state: "stopped" },
      });
    } else {
      await fs.rm(this.recordPath(record.id), { force: true });
    }
  }

  async retireStoppedRuntime(runtime: ManagedRuntime): Promise<void> {
    const records = await this.list({ includeStopped: true });
    for (const candidate of records) {
      if (
        candidate.runtime?.agentId !== runtime.agentId ||
        candidate.runtime.generationId !== runtime.generationId
      )
        continue;
      await this.serialize(candidate.id, async () => {
        await this.repairPublication(candidate.id);
        const record = await this.readRecord(candidate.id);
        if (record?.tree?.state !== "stopped") return;
        await fs.rm(this.recordPath(record.id), { force: true });
      });
    }
  }

  private async readRecord(id: string): Promise<ManagedProcessRecord | null> {
    try {
      const record = ManagedProcessRecordSchema.parse(
        JSON.parse(await fs.readFile(this.recordPath(id), "utf8")),
      );
      if (record.id !== id) throw new ManagedProcessInspectionError(record.pid);
      return record;
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async repairPublication(id: string): Promise<void> {
    const candidate = this.unpublished.get(id);
    if (!candidate) return;
    // A failed opening marker prevented the OS inspection from starting. Only
    // this in-memory failed operation proves that no observation was lost.
    const repaired = candidate.tree?.inspectionPending
      ? { ...candidate, tree: { ...candidate.tree, inspectionPending: false } }
      : candidate;
    await this.publish(repaired);
  }

  private async publish(record: ManagedProcessRecord): Promise<void> {
    const filePath = this.recordPath(record.id);
    this.unpublished.set(record.id, record);
    await writeJsonFileAtomic(filePath, record);
    if (record.tree) await this.syncPublication(filePath, this.paseoHome);
    this.unpublished.delete(record.id);
  }

  private async serialize(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.writes.set(id, next);
    try {
      await next;
    } finally {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }
  }

  async list(options?: { includeStopped?: boolean }): Promise<ManagedProcessRecord[]> {
    const { entries, errors } = await this.readEntries();
    if (errors.length > 0) throw new ManagedProcessInventoryError(errors);
    return entries
      .map((entry) => entry.record)
      .filter((record) => options?.includeStopped || record.tree?.state !== "stopped");
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    const inventory = await this.readEntries();
    const result: ManagedProcessReapResult = {
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: inventory.errors,
    };

    for (const entry of inventory.entries) {
      if (entry.record.tree?.state === "stopped") continue;
      result.checked += 1;
      try {
        if (entry.record.tree) {
          await this.stop(entry.record.id);
          result.terminated += 1;
          if (!entry.record.runtime) result.removed += 1;
          continue;
        }
        const inspection = await this.processTable.inspect(entry.record.pid);
        if (inspection.status === "not-found") {
          await fs.rm(entry.path, { force: true });
          result.dead += 1;
          result.removed += 1;
          continue;
        }

        if (inspection.status === "error") {
          // Inspection failed, so we cannot tell whether the helper is still
          // alive. Keep the record and retry on the next reconcile rather than
          // orphaning a live process by deleting its record without killing it.
          const message =
            inspection.error instanceof Error ? inspection.error.message : String(inspection.error);
          result.errors.push({ id: entry.record.id, message });
          this.logger.warn(
            {
              err: inspection.error,
              id: entry.record.id,
              pid: entry.record.pid,
              owner: entry.record.owner,
            },
            "Could not inspect managed helper process; leaving record for next reconcile",
          );
          continue;
        }

        const snapshot = inspection.snapshot;
        if (!processIdentityMatches(entry.record, snapshot)) {
          await fs.rm(entry.path, { force: true });
          result.mismatched += 1;
          result.removed += 1;
          continue;
        }

        const termination = await this.terminateProcess(createPidTarget(entry.record.pid), {
          gracefulTimeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
          forceTimeoutMs: MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS,
          onForceSignal: () => {
            this.logger.warn(
              {
                pid: entry.record.pid,
                owner: entry.record.owner,
                timeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
              },
              "Managed helper process did not exit after SIGTERM; sending SIGKILL",
            );
          },
        });
        if (termination === "kill-timeout") {
          throw new ManagedProcessTerminationError(entry.record.pid, "timeout");
        }
        await this.confirmProcessExited(entry.record);
        await fs.rm(entry.path, { force: true });
        result.terminated += 1;
        result.removed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ id: entry.record.id, message });
        this.logger.warn(
          { err: error, id: entry.record.id, pid: entry.record.pid, owner: entry.record.owner },
          "Failed to reap managed helper process",
        );
      }
    }

    return result;
  }

  private async confirmProcessExited(record: ManagedProcessRecord): Promise<void> {
    if (record.tree) {
      if (record.tree.state === "stopped") return;
      const bootId = await (this.processTree?.bootId ?? readProcessBootId)();
      if (record.tree.checkpoint.bootId !== bootId) return;
      if (record.tree.inspectionPending || record.tree.state === "running")
        throw new ManagedProcessInspectionError(record.pid);
      if (await isProcessTreeStopped(record.tree.checkpoint, this.processTree)) return;
      throw new ManagedProcessTerminationError(record.pid, "still_running");
    }
    const inspection = await this.processTable.inspect(record.pid);
    if (inspection.status === "not-found") return;
    if (inspection.status === "error") throw inspection.error;
    const previousStart = record.identity.startedAt;
    const currentStart = inspection.snapshot.startedAt;
    // A reused PID proves the original helper exited. Changed argv alone does
    // not: a live helper can exec another program while retaining its identity.
    if (previousStart && currentStart && previousStart !== currentStart) return;
    throw new ManagedProcessTerminationError(record.pid, "still_running");
  }

  private recordPath(id: string): string {
    if (!MANAGED_PROCESS_ID_PATTERN.test(id)) {
      throw new Error(`Invalid managed process record id: ${id}`);
    }
    return path.join(this.directory, `${id}.json`);
  }

  private async readEntries(): Promise<ManagedProcessInventory> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.directory);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return { entries: [], errors: [] };
      }
      throw error;
    }

    const entries: ManagedProcessEntry[] = [];
    const errors: ManagedProcessReapResult["errors"] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.directory, fileName);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = ManagedProcessRecordSchema.parse(JSON.parse(raw));
        if (fileName !== `${parsed.id}.json`) throw new ManagedProcessInspectionError(parsed.pid);
        entries.push({ path: filePath, record: parsed });
      } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) continue;
        // Keep reaping valid entries, but never report an incomplete inventory
        // as an empty one that could certify handoff quiescence.
        errors.push({
          id: fileName,
          message: error instanceof Error ? error.message : String(error),
        });
        this.logger.warn(
          { err: error, file: fileName },
          "Skipping unreadable managed process record",
        );
      }
    }
    return { entries, errors };
  }
}

function processIdentityMatches(
  record: ManagedProcessRecord,
  snapshot: ManagedProcessSnapshot,
): boolean {
  if (record.identity.startedAt && snapshot.startedAt) {
    if (record.identity.startedAt !== snapshot.startedAt) {
      return false;
    }
    if (record.identity.commandLine && snapshot.commandLine) {
      // Keep the OS's quoting instead of reconstructing argv. In particular,
      // Windows quotes executable paths under Program Files.
      return record.identity.commandLine === snapshot.commandLine;
    }
    return snapshot.commandLine ? commandLineMatchesRecord(record, snapshot.commandLine) : true;
  }

  if (record.identity.commandLine && snapshot.commandLine) {
    return (
      normalizeCommandLine(record.identity.commandLine) ===
      normalizeCommandLine(snapshot.commandLine)
    );
  }

  return snapshot.commandLine ? commandLineMatchesRecord(record, snapshot.commandLine) : false;
}

function commandLineMatchesRecord(record: ManagedProcessRecord, commandLine: string): boolean {
  // Require the command name and args as one contiguous run, not scattered
  // tokens. Without exact process identity (lstart), a reused PID whose command
  // line merely mentions "opencode", "serve" and the port elsewhere must not be
  // mistaken for our leftover and killed.
  const normalized = normalizeCommandLine(commandLine);
  const commandName = path.basename(record.command).toLowerCase();
  const signature = [commandName, ...record.args].map((token) => token.toLowerCase()).join(" ");
  return normalized.includes(signature);
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.replace(/\s+/g, " ").trim().toLowerCase();
}

export function createPidTarget(pid: number): TreeKillTarget {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals | number) {
      process.kill(pid, signal);
      return true;
    },
    // The reaper has no ChildProcess handle for a leftover from a previous
    // daemon, so it observes exit by polling the pid. Without this, termination
    // can never see a graceful SIGTERM exit and always waits out the full
    // graceful+force window before escalating to SIGKILL.
    once(_event, listener) {
      const timer = setInterval(() => {
        if (!isProcessAlive(pid)) {
          clearInterval(timer);
          listener();
        }
      }, MANAGED_PROCESS_EXIT_POLL_INTERVAL_MS);
      timer.unref();
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorWithCode(error, "EPERM");
  }
}

function isNoMatchingProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 1 &&
    "stdout" in error &&
    typeof error.stdout === "string" &&
    error.stdout.trim() === "" &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim() === ""
  );
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
