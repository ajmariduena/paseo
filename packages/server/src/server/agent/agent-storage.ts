import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { writeJsonFileAtomic, syncFilePublication } from "../atomic-file.js";
import { AGENT_TURN_OUTCOMES } from "@getpaseo/protocol/agent-lifecycle";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";
import { HandoffContextSchema } from "../handoff/context.js";
import {
  initialPromptAnnotationCheckpoint,
  PromptAnnotationCheckpointSchema,
  PromptAnnotationPublicationSchema,
  type PromptAnnotationCheckpoint,
  type PromptAnnotationPublication,
} from "./prompt-annotations.js";

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

export const RestartCancelledWorkSchema = z.object({
  kind: z.string(),
  label: z.string(),
  id: z.string(),
});

const RuntimeGenerationSchema = z.object({
  id: z.string().uuid(),
  openedAt: z.string(),
});

const CarriedPromptSchema = z.object({
  id: z.string().uuid(),
  generationId: z.string().uuid(),
  nativeMessageId: z.string().uuid().optional(),
  restartNote: z.array(RestartCancelledWorkSchema).max(1024),
  handoffContext: HandoffContextSchema.optional(),
});
const CarriedPromptSettlementSchema = z.object({
  id: z.string().uuid(),
  generationId: z.string().uuid(),
  outcome: z.enum(["completed", "not_completed", "withdrawn"]),
});
export type CarriedPrompt = z.infer<typeof CarriedPromptSchema>;
export interface CarriedPromptSettlement {
  delivery: CarriedPrompt;
  outcome: z.infer<typeof CarriedPromptSettlementSchema>["outcome"];
}

const STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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
  handoffContext: HandoffContextSchema.optional(),
  runtimeGeneration: RuntimeGenerationSchema.optional(),
  unresolvedRuntimeGenerations: z.array(RuntimeGenerationSchema).max(32).optional(),
  promptAnnotations: PromptAnnotationCheckpointSchema.optional(),
  pendingPromptAnnotationPublication: PromptAnnotationPublicationSchema.optional(),
  carriedPrompt: CarriedPromptSchema.optional(),
  lastCarriedPromptSettlement: CarriedPromptSettlementSchema.optional(),
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

export class AgentRecordConflictError extends Error {
  constructor(
    readonly agentId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Agent record revision changed for ${agentId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "AgentRecordConflictError";
  }
}

function sameRecordContent(left: StoredAgentRecord, right: StoredAgentRecord): boolean {
  // Compare the persisted representation: optional undefined fields disappear on disk.
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify({ ...left, revision: undefined })),
    JSON.parse(JSON.stringify({ ...right, revision: undefined })),
  );
}

function recordRecoveryState(record: StoredAgentRecord | null) {
  return {
    runtimeGeneration: record?.runtimeGeneration,
    unresolvedRuntimeGenerations: record?.unresolvedRuntimeGenerations,
    promptAnnotations: record?.promptAnnotations,
    pendingPromptAnnotationPublication: record?.pendingPromptAnnotationPublication,
    carriedPrompt: record?.carriedPrompt,
    lastCarriedPromptSettlement: record?.lastCarriedPromptSettlement,
  };
}

interface StoredAgentFile {
  record: StoredAgentRecord;
  filePath: string;
}
interface PendingRecordPublication {
  record: StoredAgentRecord;
  synchronize?: typeof syncFilePublication;
}
export type RestartCancelledWork = z.infer<typeof RestartCancelledWorkSchema>;
export type AgentCreationRequest = NonNullable<StoredAgentRecord["creation"]>;
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<StoredAgentRecord | undefined>> = new Map();
  private pendingPublications: Map<string, PendingRecordPublication> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;
  private logger: Logger;

  constructor(
    baseDir: string,
    logger: Logger,
    private readonly isVisible: (id: string) => boolean = () => true,
    private readonly syncPublication: typeof syncFilePublication = syncFilePublication,
    private readonly acquireRecordMutation?: (record: StoredAgentRecord) => () => void,
  ) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async list(): Promise<StoredAgentRecord[]> {
    await this.load();
    return structuredClone(
      Array.from(this.cache.values()).filter((record) => this.isVisible(record.id)),
    );
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.isVisible(agentId) ? structuredClone(this.cache.get(agentId) ?? null) : null;
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    return structuredClone(
      Array.from(this.cache.values()).filter(
        (record) =>
          this.isVisible(record.id) &&
          record.persistence?.provider === provider &&
          (record.persistence.sessionId === providerHandleId ||
            record.persistence.nativeHandle === providerHandleId),
      ),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    await this.load();
    return structuredClone(
      Array.from(this.cache.values()).filter(
        (record) => this.isVisible(record.id) && record.workspaceId === workspaceId,
      ),
    );
  }

  async listByWorkspaceForHandoff(workspaceId: string): Promise<StoredAgentRecord[]> {
    await this.load();
    await Promise.all(this.pendingWrites.values());
    const pending = [...this.pendingPublications.values()].filter(
      ({ record }) => record.workspaceId === workspaceId,
    );
    await Promise.all(pending.map(({ record }) => this.repairPendingPersistence(record.id)));
    // A sidebar can omit damaged records; a handoff cannot certify an incomplete inventory.
    const files = await this.readDiskRecords({ requireComplete: true });
    const records = files
      .map((file) => file.record)
      .filter((record) => record.workspaceId === workspaceId);
    const expected = await this.listByWorkspace(workspaceId);
    const byId = new Map(records.map((record) => [record.id, record]));
    if (
      byId.size !== records.length ||
      expected.length !== records.length ||
      expected.some(
        (record) =>
          !isDeepStrictEqual(
            parseStoredAgentRecord(JSON.parse(JSON.stringify(record))),
            byId.get(record.id),
          ),
      )
    )
      throw new Error("Handoff agent inventory differs from persisted storage");
    return records;
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? this.get(agentId) : null;
  }

  async installHandoffRecord(record: StoredAgentRecord): Promise<void> {
    const parsed = structuredClone(parseStoredAgentRecord(record));
    await this.load();
    await this.queueRecordMutation(
      parsed.id,
      (existing) => {
        if (existing && !sameRecordContent(existing, parsed))
          throw new Error("Handoff agent identity is already occupied");
        return parsed;
      },
      this.syncPublication,
    );
  }

  async upsert(record: StoredAgentRecord): Promise<StoredAgentRecord> {
    const candidate = structuredClone(record);
    await this.load();
    const committed = await this.queueRecordMutation(candidate.id, (existing) => {
      this.assertRuntimeGeneration(existing, candidate.runtimeGeneration?.id);
      this.assertRuntimeNotReopened(existing, candidate);
      const next = {
        ...candidate,
        ...recordRecoveryState(existing),
        pendingRestartNote: existing ? existing.pendingRestartNote : candidate.pendingRestartNote,
      };
      // Identical retries reuse the committed revision, including after publication repair.
      if (existing && sameRecordContent(existing, next)) return existing;
      // COMPAT(agentRecordRevision): added in v0.11.1, remove after 2027-04-10 once legacy records have been written.
      const expectedRevision = candidate.revision ?? 0;
      const actualRevision = existing?.revision ?? 0;
      if (expectedRevision !== actualRevision)
        throw new AgentRecordConflictError(candidate.id, expectedRevision, actualRevision);
      return next;
    });
    if (!committed) throw new Error("Agent was deleted before its record could be saved");
    return committed;
  }

  async beginRuntimeGeneration(seed: StoredAgentRecord): Promise<string> {
    const input = structuredClone(seed);
    const generation = { id: randomUUID(), openedAt: new Date().toISOString() };
    await this.load();
    const opened = await this.queueRecordMutation(
      input.id,
      (existing) => {
        const unresolved = [...(existing?.unresolvedRuntimeGenerations ?? [])];
        if (existing && existing.lastStatus !== "closed") {
          if (unresolved.length === 32)
            throw new Error("Agent runtime recovery is required before another opening");
          unresolved.push(
            existing.runtimeGeneration ?? { id: randomUUID(), openedAt: existing.updatedAt },
          );
        }
        return {
          ...input,
          ...existing,
          provider: input.provider,
          cwd: input.cwd,
          workspaceId: input.workspaceId ?? existing?.workspaceId,
          config: input.config,
          persistence: input.persistence ?? existing?.persistence,
          lastStatus: "initializing",
          runtimeGeneration: generation,
          unresolvedRuntimeGenerations: unresolved.length ? unresolved : undefined,
          promptAnnotations: existing
            ? existing.promptAnnotations
            : initialPromptAnnotationCheckpoint(input.persistence ? "adopted" : "from_creation"),
        };
      },
      process.platform === "win32" ? undefined : this.syncPublication,
    );
    if (!opened) throw new Error("Agent was deleted before opening its runtime");
    return generation.id;
  }

  async restoreArchivedImportPlacement(
    original: StoredAgentRecord,
    imported: { workspaceId: string; labels: Record<string, string | null> },
  ): Promise<void> {
    const before = structuredClone(original);
    const applied = structuredClone(imported);
    await this.load();
    await this.queueRecordMutation(before.id, (record) => {
      if (!record || !before.archivedAt || record.archivedAt !== before.archivedAt)
        throw new Error("Imported agent must be re-archived before restoring its placement");
      const labels = { ...record.labels };
      // Undo only this import's patch; a concurrent edit owns its newer value.
      for (const [key, value] of Object.entries(applied.labels)) {
        if (labels[key] !== (value ?? undefined)) continue;
        if (Object.hasOwn(before.labels, key)) labels[key] = before.labels[key];
        else delete labels[key];
      }
      return {
        ...record,
        workspaceId:
          record.workspaceId === applied.workspaceId ? before.workspaceId : record.workspaceId,
        labels,
      };
    });
  }

  private assertRuntimeGeneration(record: StoredAgentRecord | null, generationId?: string): void {
    if (record?.runtimeGeneration?.id !== generationId)
      throw new Error("Agent snapshot belongs to a different runtime generation");
  }

  private assertRuntimeNotReopened(
    existing: StoredAgentRecord | null,
    next: StoredAgentRecord,
  ): void {
    if (
      existing?.runtimeGeneration &&
      existing.lastStatus === "closed" &&
      next.lastStatus !== "closed"
    )
      throw new Error("Agent runtime generation is already closed");
  }

  async repairPendingPersistence(agentId: string): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId);
  }

  async retryClosedSnapshot(agentId: string): Promise<void> {
    await this.repairPendingPersistence(agentId);
    const saved = await this.get(agentId);
    if (!saved || saved.lastStatus !== "closed") return;
    // After restart, a renamed record may exist without its previous sync acknowledgement.
    // This republishes known closure only; carried prompts and generation faults remain intact.
    await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record || record.lastStatus !== "closed")
          throw new Error("Stored agent reopened before closure could be synchronized");
        return record;
      },
      process.platform === "win32" ? undefined : this.syncPublication,
    );
  }

  async checkpointClosedAgent(agentId: string): Promise<StoredAgentRecord> {
    await this.load();
    const checkpoint = await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record || !this.isVisible(agentId) || record.lastStatus !== "closed")
          throw new Error("Handoff requires a persisted closed agent");
        if (record.unresolvedRuntimeGenerations?.length)
          throw new Error("Handoff requires recovery of unresolved runtime generations");
        if (record.pendingPromptAnnotationPublication)
          throw new Error("Handoff requires repair of pending prompt annotation publication");
        if (record.carriedPrompt)
          throw new Error("Handoff requires resolution of carried prompt delivery");
        return record;
      },
      this.syncPublication,
    );
    if (!checkpoint) throw new Error("Handoff agent was deleted during persistence");
    return checkpoint;
  }

  async adoptPromptAnnotationCheckpoint(
    agentId: string,
    checkpoint: PromptAnnotationCheckpoint,
  ): Promise<void> {
    const input = PromptAnnotationCheckpointSchema.parse(checkpoint);
    if (input.revision !== 0 || input.coverage !== "adopted")
      throw new Error("Invalid annotation checkpoint adoption");
    await this.load();
    const committed = await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record) throw new Error(`Agent ${agentId} not found`);
        if (record.pendingPromptAnnotationPublication)
          throw new Error("Prompt annotation publication is pending");
        if (record.promptAnnotations && !isDeepStrictEqual(record.promptAnnotations, input))
          throw new Error("Prompt annotation checkpoint changed");
        return { ...record, promptAnnotations: input };
      },
      process.platform === "win32" ? undefined : this.syncPublication,
    );
    if (!committed) throw new Error("Agent was deleted during annotation publication");
  }

  async preparePromptAnnotationPublication(
    agentId: string,
    publication: PromptAnnotationPublication,
  ): Promise<void> {
    const input = PromptAnnotationPublicationSchema.parse(publication);
    const appended = input.change.beforeDigest === null;
    const expectedCount = input.base.entryCount + (appended ? 1 : 0);
    if (
      input.next.revision !== input.base.revision + 1 ||
      input.next.entryCount !== expectedCount ||
      input.next.coverage !== input.base.coverage
    )
      throw new Error("Invalid prompt annotation publication transition");
    // The bounded annotation entry also needs its fixed checkpoint/delta envelope.
    if (Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024 + 4096)
      throw new Error("Prompt annotation repair input exceeds capacity");
    await this.load();
    const committed = await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record) throw new Error(`Agent ${agentId} not found`);
        if (!isDeepStrictEqual(record.promptAnnotations, input.base))
          throw new Error("Prompt annotation checkpoint changed");
        if (
          record.pendingPromptAnnotationPublication &&
          !isDeepStrictEqual(record.pendingPromptAnnotationPublication, input)
        )
          throw new Error("A different prompt annotation publication is pending");
        return { ...record, pendingPromptAnnotationPublication: input };
      },
      process.platform === "win32" ? undefined : this.syncPublication,
    );
    if (!committed) throw new Error("Agent was deleted during annotation publication");
  }

  async commitPromptAnnotationPublication(
    agentId: string,
    publication: PromptAnnotationPublication,
  ): Promise<void> {
    const input = PromptAnnotationPublicationSchema.parse(publication);
    await this.load();
    const committed = await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record) throw new Error(`Agent ${agentId} not found`);
        if (isDeepStrictEqual(record.promptAnnotations, input.next)) return record;
        if (
          !isDeepStrictEqual(record.promptAnnotations, input.base) ||
          !isDeepStrictEqual(record.pendingPromptAnnotationPublication, input)
        )
          throw new Error("Prompt annotation publication does not match its prepared input");
        const { pendingPromptAnnotationPublication: _settled, ...rest } = record;
        return { ...rest, promptAnnotations: input.next };
      },
      process.platform === "win32" ? undefined : this.syncPublication,
    );
    if (!committed) throw new Error("Agent was deleted during annotation publication");
  }

  private queueRecordMutation(
    agentId: string,
    mutate?: (existing: StoredAgentRecord | null) => StoredAgentRecord,
    synchronize?: typeof syncFilePublication,
  ): Promise<StoredAgentRecord | undefined> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    // Queue progress is independent of the preceding caller's rejected outcome.
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        if (this.deleting.has(agentId)) {
          return undefined;
        }
        if (synchronize && process.platform === "win32")
          throw new Error("Durable directory publication is unavailable on Windows");

        // A failed publication retains its exact input and durability requirement.
        // Later mutations cannot overwrite it or evaluate against an uncommitted cache.
        await this.publishPendingRecord(agentId);
        if (!mutate) return undefined;
        const existing = this.cache.get(agentId) ?? null;
        const record = structuredClone(mutate(existing));
        const unchanged = existing && sameRecordContent(existing, record);
        if (unchanged && existing.revision !== undefined) {
          record.revision = existing.revision;
        } else {
          // Revisions belong to this serialized publication, never to a caller's candidate.
          const revision = (existing?.revision ?? 0) + 1;
          if (!Number.isSafeInteger(revision))
            throw new Error("Agent record revision capacity exceeded");
          record.revision = revision;
        }
        await this.publishPendingRecord(agentId, { record, synchronize });
        return structuredClone(record);
      });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private acquireRecordChange(
    existing: StoredAgentRecord | null,
    next: StoredAgentRecord | null,
  ): () => void {
    if (!this.acquireRecordMutation || (existing && next && sameRecordContent(existing, next)))
      return () => {};
    const releases: Array<() => void> = [];
    const release = () => releases.forEach((finish) => finish());
    try {
      if (existing) releases.push(this.acquireRecordMutation(existing));
      if (next) releases.push(this.acquireRecordMutation(next));
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async publishPendingRecord(
    agentId: string,
    candidate?: PendingRecordPublication,
  ): Promise<void> {
    const publication = candidate ?? this.pendingPublications.get(agentId);
    if (!publication) return;
    const release = this.acquireRecordChange(this.cache.get(agentId) ?? null, publication.record);
    try {
      // A refused write was never admitted and must not become a delayed retry.
      if (candidate) this.pendingPublications.set(agentId, candidate);
      await this.publishRecord(agentId, publication);
    } finally {
      release();
    }
  }

  private async publishRecord(
    agentId: string,
    publication: PendingRecordPublication,
  ): Promise<void> {
    const { record, synchronize } = publication;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    await writeJsonFileAtomic(nextPath, record);
    // Track renamed files for deletion even when the subsequent sync fails.
    this.addIndexedPath(agentId, nextPath);
    await synchronize?.(nextPath, path.dirname(this.baseDir));

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
    this.pendingPublications.delete(agentId);
  }

  beginDelete(agentId: string): void {
    const record = this.cache.get(agentId) ?? this.pendingPublications.get(agentId)?.record ?? null;
    const release = this.acquireRecordChange(record, null);
    try {
      this.deleting.add(agentId);
    } finally {
      release();
    }
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    const record = this.cache.get(agentId) ?? this.pendingPublications.get(agentId)?.record ?? null;
    const release = this.acquireRecordChange(record, null);
    try {
      await this.removeRecord(agentId);
    } finally {
      release();
    }
  }

  private async removeRecord(agentId: string): Promise<void> {
    this.beginDelete(agentId);
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
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
    this.pendingPublications.delete(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    const snapshot = structuredClone(
      toStoredAgentRecord(agent, {
        ...options,
        internal: hasInternalOverride ? options?.internal : agent.internal,
      }),
    );
    const generationId = agent.runtimeGenerationId;
    await this.load();
    const synchronize =
      snapshot.lastStatus === "closed" && process.platform !== "win32"
        ? this.syncPublication
        : undefined;
    await this.queueRecordMutation(
      snapshot.id,
      (existing) => {
        this.assertRuntimeGeneration(existing, generationId);
        this.assertRuntimeNotReopened(existing, snapshot);
        const record: StoredAgentRecord = {
          ...snapshot,
          title: hasTitleOverride ? snapshot.title : (existing?.title ?? null),
          createdAt: existing?.createdAt ?? snapshot.createdAt,
          internal: hasInternalOverride
            ? snapshot.internal
            : (snapshot.internal ?? existing?.internal),
          ...recordRecoveryState(existing),
        };

        // Preserve soft-delete/archive status across snapshot flushes. The
        // merge runs inside the per-agent write queue so it cannot commit a
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
        if (existing?.handoffContext) record.handoffContext = existing.handoffContext;
        return record;
      },
      synchronize,
    );
  }

  async prepareCarriedPrompt(agentId: string, delivery: CarriedPrompt): Promise<void> {
    const input = CarriedPromptSchema.parse(delivery);
    if (!input.restartNote.length && !input.handoffContext)
      throw new Error("Carried prompt has no pending context");
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024)
      throw new Error("Carried prompt recovery input exceeds capacity");
    await this.load();
    const committed = await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record) throw new Error(`Agent ${agentId} not found`);
        this.assertRuntimeGeneration(record, input.generationId);
        if (record.lastStatus === "closed") throw new Error("Carried prompt runtime is closed");
        if (record.carriedPrompt && !isDeepStrictEqual(record.carriedPrompt, input))
          throw new Error("Prior carried prompt delivery is unresolved");
        if (
          input.restartNote.some(
            (entry) =>
              !record.pendingRestartNote?.some((pending) => isDeepStrictEqual(entry, pending)),
          )
        )
          throw new Error("Pending restart note changed before dispatch");
        if (
          input.handoffContext &&
          (!input.handoffContext.pending ||
            !isDeepStrictEqual(record.handoffContext, input.handoffContext))
        )
          throw new Error("Handoff context changed before dispatch");
        return { ...record, carriedPrompt: input };
      },
      process.platform === "win32" ? undefined : this.syncPublication,
    );
    if (!committed) throw new Error("Agent was deleted before carrying context");
  }

  async settleCarriedPrompt(agentId: string, settlement: CarriedPromptSettlement): Promise<void> {
    const delivery = CarriedPromptSchema.parse(settlement.delivery);
    const receipt = CarriedPromptSettlementSchema.parse({
      id: delivery.id,
      generationId: delivery.generationId,
      outcome: settlement.outcome,
    });
    await this.load();
    const committed = await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record) throw new Error(`Agent ${agentId} not found`);
        this.assertRuntimeGeneration(record, delivery.generationId);
        if (isDeepStrictEqual(record.lastCarriedPromptSettlement, receipt)) return record;
        const neverAdmitted = receipt.outcome === "withdrawn" && !record.carriedPrompt;
        if (!neverAdmitted && !isDeepStrictEqual(record.carriedPrompt, delivery))
          throw new Error("Carried prompt settlement does not match the pending delivery");
        const { carriedPrompt: _settled, ...next } = record;
        if (receipt.outcome === "completed") {
          if (delivery.handoffContext) {
            if (!isDeepStrictEqual(record.handoffContext, delivery.handoffContext))
              throw new Error("Handoff context changed before completion");
            next.handoffContext = { ...delivery.handoffContext, pending: false };
          }
          const remaining = record.pendingRestartNote?.filter(
            (entry) =>
              !delivery.restartNote.some((delivered) => isDeepStrictEqual(entry, delivered)),
          );
          next.pendingRestartNote = remaining?.length ? remaining : undefined;
        }
        return { ...next, lastCarriedPromptSettlement: receipt };
      },
      process.platform === "win32" ? undefined : this.syncPublication,
    );
    if (!committed) throw new Error("Agent was deleted during carried prompt settlement");
  }

  /** Acknowledgement lets restart recovery consume its retry input; entries dedupe by id. */
  async addPendingRestartNote(
    agentId: string,
    work: readonly RestartCancelledWork[],
  ): Promise<void> {
    const entries = structuredClone(work);
    await this.load();
    await this.queueRecordMutation(
      agentId,
      (existing) => {
        if (!existing) {
          throw new Error(`Agent ${agentId} not found`);
        }
        const pending = [...(existing.pendingRestartNote ?? [])];
        for (const entry of entries) {
          if (!pending.some((candidate) => candidate.id === entry.id)) pending.push(entry);
        }
        return { ...existing, pendingRestartNote: pending };
      },
      process.platform === "win32" ? undefined : this.syncPublication,
    );
  }

  /** Records the idempotency key the agent was created under, for retried create requests. */
  async setCreation(agentId: string, creation: AgentCreationRequest): Promise<void> {
    const request = structuredClone(creation);
    await this.load();
    await this.queueRecordMutation(agentId, (existing) => {
      if (!existing) {
        throw new Error(`Agent ${agentId} not found`);
      }
      return { ...existing, creation: request };
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
        return structuredClone(record);
      }
    }
    return null;
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      if (!record || !this.isVisible(agentId)) throw new Error(`Agent ${agentId} not found`);
      return { ...record, title };
    });
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
    const loaded = await this.readDiskRecords({ requireComplete: false });
    const records: StoredAgentRecord[] = [];
    for (const { record, filePath } of loaded) {
      records.push(record);
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }
    return records;
  }

  private async readDiskRecords(options: { requireComplete: boolean }): Promise<StoredAgentFile[]> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch (error) {
          if (options.requireComplete) throw error;
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath, options);
        return record ? { record, filePath } : null;
      }),
    );

    return loaded.filter((item) => item !== null);
  }

  private async readRecordFile(
    filePath: string,
    options: { requireComplete: boolean },
  ): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      if (options.requireComplete) throw error;
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
