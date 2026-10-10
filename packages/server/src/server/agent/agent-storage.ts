import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { AGENT_TURN_OUTCOMES } from "@getpaseo/protocol/agent-lifecycle";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";
import {
  PendingProviderSwitchSchema,
  ProviderSegmentSchema,
  SwitchOperationSchema,
  retainSwitchOperations,
} from "./provider-switch/record.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

const RestartCancelledWorkSchema = z.object({
  kind: z.string(),
  label: z.string(),
  id: z.string(),
});

const STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  lastTurnOutcome: z.enum(AGENT_TURN_OUTCOMES).optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  owner: AgentOwnerSchema.optional(),
  creation: z
    .object({
      callerAgentId: z.string().nullable(),
      clientRequestId: z.string(),
    })
    .optional(),
  /** Background work a restart cancelled, told to the agent's next turn once it completes. */
  pendingRestartNote: z.array(RestartCancelledWorkSchema).optional(),
  /** Provider segments of a switched agent; absent means one implicit segment. */
  providerSegments: z.array(ProviderSegmentSchema).optional(),
  pendingProviderSwitch: PendingProviderSwitchSchema.nullable().optional(),
  switchOperations: z.array(SwitchOperationSchema).optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "featureValues"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;

export interface AgentRecordScan {
  records: Map<string, StoredAgentRecord>;
  unreadable: Set<string>;
  /** False when a directory could not be listed, so absence proves nothing. */
  complete: boolean;
}
export type RestartCancelledWork = z.infer<typeof RestartCancelledWorkSchema>;
export type AgentCreationRequest = NonNullable<StoredAgentRecord["creation"]>;
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

// A managed agent built before the switch state was read carries none of it; the record stays
// authoritative until the manager projects its own copy.
function preserveSwitchState(
  record: StoredAgentRecord,
  agent: ManagedAgent,
  existing: StoredAgentRecord | null,
): void {
  if (!existing) return;
  if (agent.providerSegments === undefined && existing.providerSegments) {
    record.providerSegments = existing.providerSegments;
  }
  if (agent.pendingProviderSwitch === undefined && existing.pendingProviderSwitch) {
    record.pendingProviderSwitch = existing.pendingProviderSwitch;
  }
  if (agent.switchOperations === undefined && existing.switchOperations) {
    record.switchOperations = existing.switchOperations;
  }
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;
  private logger: Logger;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async list(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cache.get(agentId) ?? null;
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter((record) => record.workspaceId === workspaceId);
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? (this.cache.get(agentId) ?? null) : null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    await this.queueRecordWrite(record);
  }

  private queueRecordWrite(record: StoredAgentRecord): Promise<void> {
    return this.queueRecordMutation(record.id, () => record);
  }

  private queueRecordMutation(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord,
  ): Promise<void> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleting.has(agentId)) {
        return undefined;
      }

      const record = mutate(this.cache.get(agentId) ?? null);
      await this.writeRecord(record);
      return undefined;
    });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    await writeJsonFileAtomic(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    await (this.pendingWrites.get(agentId) ?? Promise.resolve());
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") {
            this.logger.warn(
              { err: error, agentId, filePath },
              "Failed to remove agent record file",
            );
          }
        }
      }),
    );

    this.cache.delete(agentId);
    this.removeOwnerIndex(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    await this.load();
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    await this.queueRecordMutation(agent.id, (existing) => {
      const record = toStoredAgentRecord(agent, {
        title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
      });

      // Preserve soft-delete/archive status across snapshot flushes. The
      // projection runs inside the per-agent write queue so it cannot commit a
      // stale pre-archive record after the archive mutation.
      if (existing && existing.archivedAt !== undefined) {
        record.archivedAt = existing.archivedAt;
      }
      if (existing?.creation) {
        record.creation = existing.creation;
      }
      if (existing?.pendingRestartNote) {
        record.pendingRestartNote = existing.pendingRestartNote;
      }
      preserveSwitchState(record, agent, existing);
      return record;
    });
  }

  /**
   * One atomic write of a switch commit: the builder gets an isolated copy of the record and
   * returns the whole next record (active selection, segments, operation phase). The cache
   * only changes once the file is on disk. A caller holding a fresher read of the record than
   * the cache (boot's scan) passes it as `authoritative`; the write then reconciles the cache
   * and path index to it.
   */
  async commitProviderSwitch(
    agentId: string,
    build: (candidate: StoredAgentRecord) => StoredAgentRecord,
    options?: { authoritative?: StoredAgentRecord },
  ): Promise<StoredAgentRecord> {
    await this.load();
    let written: StoredAgentRecord | null = null;
    await this.queueRecordMutation(agentId, (existing) => {
      const current = options?.authoritative ?? existing;
      if (!current) {
        throw new Error(`Agent ${agentId} not found`);
      }
      const next = build(structuredClone(current));
      if (next.id !== agentId) {
        throw new Error(`Switch commit for ${agentId} returned record ${next.id}`);
      }
      written = {
        ...next,
        switchOperations: next.switchOperations
          ? retainSwitchOperations(next.switchOperations)
          : undefined,
      };
      return written;
    });
    if (!written) {
      throw new Error(`Agent ${agentId} is being deleted`);
    }
    return written;
  }

  /**
   * A fresh read of every record file on disk, independent of the boot cache: the records that
   * parse, the ids of files that do not, and whether the walk saw every directory. Boot cleanup
   * decides ownership from this one scan, so a record repaired after load still counts.
   */
  async scanRecords(): Promise<AgentRecordScan> {
    const { filePaths, complete } = await this.enumerateRecordFiles();
    const records = new Map<string, StoredAgentRecord>();
    const unreadable = new Set<string>();
    await Promise.all(
      filePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        if (record) {
          records.set(record.id, record);
          // The path index follows the disk, so a later write replaces this file, not a copy.
          this.pathById.set(record.id, filePath);
          this.addIndexedPath(record.id, filePath);
        } else {
          unreadable.add(path.basename(filePath, ".json"));
        }
      }),
    );
    return { records, unreadable, complete };
  }

  /** Adds work to the agent's pending restart note; entries dedupe by id. */
  async addPendingRestartNote(
    agentId: string,
    work: readonly RestartCancelledWork[],
  ): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (existing) => {
      if (!existing) {
        throw new Error(`Agent ${agentId} not found`);
      }
      const pending = [...(existing.pendingRestartNote ?? [])];
      for (const entry of work) {
        if (!pending.some((candidate) => candidate.id === entry.id)) pending.push(entry);
      }
      return { ...existing, pendingRestartNote: pending };
    });
  }

  /** A completed turn carried the note, so the agent has heard it. */
  async clearPendingRestartNote(
    agentId: string,
    delivered: readonly RestartCancelledWork[],
  ): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (existing) => {
      if (!existing) {
        throw new Error(`Agent ${agentId} not found`);
      }
      const remaining = (existing.pendingRestartNote ?? []).filter(
        (entry) => !delivered.some((heard) => heard.id === entry.id),
      );
      const { pendingRestartNote: _cleared, ...rest } = existing;
      return remaining.length > 0 ? { ...rest, pendingRestartNote: remaining } : rest;
    });
  }

  /** Records the idempotency key the agent was created under, for retried create requests. */
  async setCreation(agentId: string, creation: AgentCreationRequest): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (existing) => {
      if (!existing) {
        throw new Error(`Agent ${agentId} not found`);
      }
      return { ...existing, creation };
    });
  }

  async findByCreationRequest(creation: AgentCreationRequest): Promise<StoredAgentRecord | null> {
    await this.load();
    for (const record of this.cache.values()) {
      if (
        !record.archivedAt &&
        record.creation?.callerAgentId === creation.callerAgentId &&
        record.creation.clientRequestId === creation.clientRequestId
      ) {
        return record;
      }
    }
    return null;
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<StoredAgentRecord[]> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      const records = await this.scanDisk();
      this.loaded = true;
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return [];
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
      return [];
    }
  }

  private async scanDisk(): Promise<StoredAgentRecord[]> {
    const records: StoredAgentRecord[] = [];
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const allFilePaths = (await this.listRecordFiles(entries)).filePaths;
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { record, filePath } = item;
      records.push(record);
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }

    return records;
  }

  private async listRecordFiles(
    entries: Dirent[],
  ): Promise<{ filePaths: string[]; complete: boolean }> {
    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));
    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));
    let complete = true;
    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          complete = false;
          return [];
        }
      }),
    );
    return { filePaths: [...rootRecordPaths, ...projectFileLists.flat()], complete };
  }

  private async enumerateRecordFiles(): Promise<{ filePaths: string[]; complete: boolean }> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { filePaths: [], complete: true };
      }
      return { filePaths: [], complete: false };
    }
    return this.listRecordFiles(entries);
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
  }
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}
