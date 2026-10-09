import { createPublicKey, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HandoffArchiveManifestSchema, HandoffTransferIdSchema } from "@getpaseo/protocol/handoff";
import type { HandoffArchiveStore, VerifiedHandoffArchive } from "./archive.js";
import { readBoundedFile, syncDirectory, writeJournal } from "./artifacts.js";
import { verifyHandoffRelease, type HandoffReleaseReceipt } from "./ownership.js";
import {
  HandoffWorkspaceError,
  restoreWorkspaceFromArchive,
  verifyWorkspaceFromArchive,
} from "./workspace.js";
import { readHandoffBundle, type VerifiedHandoffBundle } from "./bundle.js";
import {
  installClaudeSessionArchive,
  verifyClaudeSessionInstallation,
  removeClaudeSessionInstallation,
} from "../agent/providers/claude/handoff.js";
import { generateProjectId, generateWorkspaceId } from "../workspace-registry-model.js";

const ReservationSchema = z.object({
  transferId: HandoffTransferIdSchema,
  sourceServerId: z.string().min(1),
  sourceWorkspaceId: z.string().min(1),
  sourceAgentIds: z.array(z.string().min(1)).max(1000),
  destinationParent: z.string().min(1),
});
const BindingSchema = z.object({
  publicKey: z.string().min(1).max(1024),
  manifest: HandoffArchiveManifestSchema,
});
const ClaudeRuntimeSchema = z.object({
  configDir: z.string().min(1),
  cliVersion: z.string().regex(/^2\.1\.\d+$/),
});
const PreparedConversationSchema = z.object({
  sourceAgentId: z.string().min(1),
  title: z.string().max(4096).nullable(),
  sessionId: z.string().uuid(),
});
const RecordSchema = ReservationSchema.extend({
  reservationId: HandoffTransferIdSchema,
  workspaceId: z.string().regex(/^wks_[a-f0-9]{16}$/),
  projectId: z.string().regex(/^prj_[a-f0-9]{16}$/),
  agentMappings: z
    .array(z.object({ sourceAgentId: z.string().min(1), destinationAgentId: z.string().uuid() }))
    .max(1000),
  destinationCwd: z.string().min(1),
  stagingCwd: z.string().min(1),
  state: z.enum(["reserved", "receiving", "staged", "released", "cancelled"]),
  binding: BindingSchema.nullable(),
  receipt: z.unknown().nullable(),
  claudeRuntime: ClaudeRuntimeSchema.nullable().default(null),
  preparedConversations: z.array(PreparedConversationSchema).max(1000).default([]),
});
const JournalSchema = z.object({
  version: z.literal(1),
  serverId: z.string().min(1),
  records: z.array(RecordSchema).max(10_000),
});
export type DestinationHandoffStatus = z.infer<typeof RecordSchema>;
type ReservationInput = z.infer<typeof ReservationSchema>;
type SourceBinding = z.infer<typeof BindingSchema>;
interface BindSourceInput extends SourceBinding {
  transferId: string;
}
interface DestinationOptions {
  directory: string;
  serverId: string;
  archives: HandoffArchiveStore;
  write?: typeof writeJournal;
  resolveClaudeRuntime?: () => Promise<z.infer<typeof ClaudeRuntimeSchema>>;
}

export class HandoffDestinationError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "invalid_state"
      | "invalid_release"
      | "not_found"
      | "storage_uncertain"
      | "unprepared_conversations"
      | "unsupported_host",
    message: string,
  ) {
    super(message);
    this.name = "HandoffDestinationError";
  }
}
function fail(code: HandoffDestinationError["code"], message: string): never {
  throw new HandoffDestinationError(code, message);
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function containerPath(
  record: Pick<DestinationHandoffStatus, "destinationParent" | "reservationId">,
): string {
  return path.join(record.destinationParent, `.paseo-handoff-${record.reservationId}`);
}

/** Destination preparation owns no runtime and publishes no workspace or conversation. */
export class HandoffDestination {
  private readonly records = new Map<string, DestinationHandoffStatus>();
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private uncertain = false;
  private closing = false;
  private readonly journal: string;

  constructor(private readonly options: DestinationOptions) {
    this.journal = path.join(options.directory, "destination.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    let created = false;
    try {
      await mkdir(this.options.directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    if (created) {
      await this.persist();
      await syncDirectory(path.dirname(this.options.directory));
    } else {
      const bytes = await readBoundedFile(this.journal, 20 * 1024 * 1024);
      const journal = JournalSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (journal.serverId !== this.options.serverId)
        fail("storage_uncertain", "Destination journal belongs to another host");
      const destinations = new Set<string>();
      const identities = new Set<string>();
      const loaded = new Map<string, DestinationHandoffStatus>();
      for (const record of journal.records) {
        if (loaded.has(record.transferId) || destinations.has(record.destinationCwd))
          fail("storage_uncertain", "Duplicate destination reservation");
        this.validateRecord(record);
        const destinationIds = record.agentMappings.map((mapping) => mapping.destinationAgentId);
        for (const identity of [
          record.reservationId,
          record.workspaceId,
          record.projectId,
          ...destinationIds,
        ]) {
          if (identities.has(identity)) fail("storage_uncertain", "Reused destination identity");
          identities.add(identity);
        }
        destinations.add(record.destinationCwd);
        loaded.set(record.transferId, record);
      }
      for (const [id, record] of loaded) this.records.set(id, record);
    }
    this.initialized = true;
  }

  reserve(input: ReservationInput): Promise<DestinationHandoffStatus> {
    const request = ReservationSchema.parse(input);
    return this.serialize(async () => {
      if (process.platform === "win32")
        fail("unsupported_host", "Durable handoff activation is not supported on Windows yet");
      const destinationParent = await realpath(request.destinationParent);
      const sourceAgentIds = [...new Set(request.sourceAgentIds)].sort();
      const canonical = { ...request, sourceAgentIds, destinationParent };
      const existing = this.records.get(request.transferId);
      if (existing) {
        if (JSON.stringify(ReservationSchema.parse(existing)) !== JSON.stringify(canonical))
          fail("conflict", "Transfer already has another destination reservation");
        return structuredClone(existing);
      }
      if (this.records.size >= 10_000)
        fail("invalid_state", "Destination journal reached its transfer limit");
      const reservationId = randomUUID();
      const workspaceId = generateWorkspaceId();
      const record: DestinationHandoffStatus = {
        ...canonical,
        reservationId,
        workspaceId,
        projectId: generateProjectId(),
        agentMappings: sourceAgentIds.map((sourceAgentId) => ({
          sourceAgentId,
          destinationAgentId: randomUUID(),
        })),
        destinationCwd: path.join(destinationParent, `paseo-${workspaceId}`),
        stagingCwd: path.join(containerPath({ destinationParent, reservationId }), "checkout"),
        state: "reserved",
        binding: null,
        receipt: null,
        claudeRuntime: null,
        preparedConversations: [],
      };
      await mkdir(containerPath(record), { mode: 0o700 });
      await syncDirectory(destinationParent);
      await this.save(record);
      return structuredClone(record);
    });
  }

  bindSource(input: BindSourceInput): Promise<DestinationHandoffStatus> {
    const binding = BindingSchema.parse(input);
    binding.manifest.blobs.sort((left, right) => left.sha256.localeCompare(right.sha256));
    const key = createPublicKey({
      key: Buffer.from(binding.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519")
      fail("invalid_release", "Handoff source key must be Ed25519");
    return this.serialize(async () => {
      const record = this.requireRecord(input.transferId);
      if (record.state === "cancelled")
        fail("invalid_state", "Destination reservation was cancelled");
      if (record.binding) {
        if (JSON.stringify(record.binding) !== JSON.stringify(binding))
          fail("conflict", "Destination is already bound to another source key or archive");
        if (record.state === "receiving")
          await this.options.archives.begin({ id: record.transferId, manifest: binding.manifest });
        return structuredClone(record);
      }
      await this.save({ ...record, state: "receiving", binding });
      await this.options.archives.begin({ id: record.transferId, manifest: binding.manifest });
      return this.status(record.transferId);
    });
  }

  stage(transferId: string): Promise<DestinationHandoffStatus> {
    return this.serialize(async () => {
      let record = this.requireRecord(transferId);
      if (!record.binding || record.state === "cancelled")
        fail("invalid_state", "Destination cannot stage this transfer");
      await this.assertContainer(record);
      return this.options.archives.withVerifiedArchive(transferId, async (archive) => {
        const content = await this.readBundle(record, archive);
        if (record.sourceAgentIds.length > 0 && record.claudeRuntime === null) {
          if (!this.options.resolveClaudeRuntime)
            fail(
              "unprepared_conversations",
              "Claude native session installation is unavailable on this host",
            );
          const runtime = ClaudeRuntimeSchema.parse(await this.options.resolveClaudeRuntime());
          if (!path.isAbsolute(runtime.configDir))
            fail("invalid_state", "Claude configuration directory must be absolute");
          record = { ...record, claudeRuntime: runtime };
          // Keep the provider location fixed across a crash or a later host configuration change.
          await this.save(record);
        }
        if (record.state === "staged" || record.state === "released") {
          try {
            await this.verifyContents(record, archive, content);
            return structuredClone(record);
          } catch (error) {
            const changed =
              error instanceof HandoffWorkspaceError && error.code === "source_changed";
            if (!changed && !isMissing(error)) throw error;
          }
        }
        await rm(record.stagingCwd, { recursive: true, force: true });
        await restoreWorkspaceFromArchive({
          archive,
          entrypoint: content.bundle.workspace,
          destination: record.stagingCwd,
        });
        const preparedConversations: DestinationHandoffStatus["preparedConversations"] = [];
        for (const conversation of content.bundle.conversations) {
          const mapping = record.agentMappings.find(
            (item) => item.sourceAgentId === conversation.sourceAgentId,
          );
          const manifest = content.sessions.get(conversation.sourceAgentId);
          if (!mapping || !manifest || !record.claudeRuntime)
            fail("unprepared_conversations", "Conversation reservation is incomplete");
          const handle = await installClaudeSessionArchive({
            manifest,
            blobsDirectory: archive.blobsDirectory,
            configDir: record.claudeRuntime.configDir,
            cliVersion: record.claudeRuntime.cliVersion,
            cwd: record.destinationCwd,
            importId: mapping.destinationAgentId,
          });
          preparedConversations.push({
            sourceAgentId: conversation.sourceAgentId,
            title: conversation.title,
            sessionId: handle.sessionId,
          });
        }
        await syncTree(record.stagingCwd);
        await syncDirectory(containerPath(record));
        await this.save({
          ...record,
          preparedConversations,
          state: record.state === "released" ? "released" : "staged",
        });
        return this.status(transferId);
      });
    });
  }

  acceptRelease(
    transferId: string,
    receipt: HandoffReleaseReceipt,
  ): Promise<DestinationHandoffStatus> {
    return this.serialize(async () => {
      const record = this.requireRecord(transferId);
      if (record.state !== "staged" && record.state !== "released")
        fail("invalid_state", "Destination is not ready for release");
      if (!this.validReceipt(record, receipt))
        fail("invalid_release", "Release does not match the reserved host, key and content");
      await this.verifyStaging(record);
      if (record.state !== "released") {
        await this.save({ ...record, state: "released", receipt });
      }
      return this.status(transferId);
    });
  }

  /** The coordinator must durably cancel the source before discarding its prepared destination. */
  cancel(transferId: string): Promise<DestinationHandoffStatus> {
    return this.serialize(async () => {
      const record = this.requireRecord(transferId);
      if (record.state === "released")
        fail("invalid_state", "Released ownership must finish activation");
      await this.save({ ...record, state: "cancelled" });
      const claudeRuntime = record.claudeRuntime;
      if (claudeRuntime) {
        await this.options.archives.withVerifiedArchive(transferId, async (archive) => {
          const content = await this.readBundle(record, archive);
          for (const mapping of record.agentMappings) {
            const manifest = content.sessions.get(mapping.sourceAgentId);
            if (!manifest) fail("unprepared_conversations", "Missing conversation during cleanup");
            await removeClaudeSessionInstallation({
              configDir: claudeRuntime.configDir,
              importId: mapping.destinationAgentId,
              manifest,
            });
          }
        });
      }
      try {
        await this.assertContainer(record);
      } catch (error) {
        if (isMissing(error)) return this.status(transferId);
        throw error;
      }
      await rm(containerPath(record), { recursive: true });
      await syncDirectory(record.destinationParent);
      return this.status(transferId);
    });
  }

  status(transferId: string): DestinationHandoffStatus {
    this.assertHealthy();
    return structuredClone(this.requireRecord(transferId));
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.tail;
  }

  private validateRecord(record: DestinationHandoffStatus): void {
    if (
      !path.isAbsolute(record.destinationParent) ||
      record.stagingCwd !== path.join(containerPath(record), "checkout") ||
      record.destinationCwd !== path.join(record.destinationParent, `paseo-${record.workspaceId}`)
    )
      fail("storage_uncertain", "Invalid destination reservation paths");
    if (record.state !== "reserved" && record.state !== "cancelled" && !record.binding)
      fail("storage_uncertain", "Destination content binding is missing");
    if (
      (record.state === "reserved" && record.binding !== null) ||
      (record.state !== "released" && record.receipt !== null)
    )
      fail("storage_uncertain", "Destination journal state is inconsistent");
    if (record.state === "released" && !this.validReceipt(record, record.receipt))
      fail("storage_uncertain", "Destination release is invalid");
    this.validateConversationRecords(record);
    const sourceIds = record.agentMappings.map((mapping) => mapping.sourceAgentId);
    if (
      JSON.stringify(sourceIds) !== JSON.stringify(record.sourceAgentIds) ||
      new Set(sourceIds).size !== sourceIds.length
    )
      fail("storage_uncertain", "Invalid destination agent mappings");
  }

  private validateConversationRecords(record: DestinationHandoffStatus): void {
    if (record.claudeRuntime && !path.isAbsolute(record.claudeRuntime.configDir))
      fail("storage_uncertain", "Invalid Claude destination directory");
    const preparedIds = record.preparedConversations.map((item) => item.sourceAgentId).sort();
    if (
      new Set(preparedIds).size !== preparedIds.length ||
      preparedIds.some((id) => !record.sourceAgentIds.includes(id))
    )
      fail("storage_uncertain", "Invalid prepared conversation identities");
    if (record.state === "staged" || record.state === "released") {
      if (
        JSON.stringify(preparedIds) !== JSON.stringify([...record.sourceAgentIds].sort()) ||
        (preparedIds.length > 0 && !record.claudeRuntime)
      )
        fail("storage_uncertain", "Destination conversation installation is incomplete");
    }
  }

  private validReceipt(record: DestinationHandoffStatus, receipt: unknown): boolean {
    if (!record.binding) return false;
    return verifyHandoffRelease(
      receipt,
      {
        version: 1,
        transferId: record.transferId,
        sourceServerId: record.sourceServerId,
        destinationServerId: this.options.serverId,
        reservationId: record.reservationId,
        manifestDigest: record.binding.manifest.entrypoint.sha256,
      },
      record.binding.publicKey,
    );
  }

  private async assertContainer(record: DestinationHandoffStatus): Promise<void> {
    const container = containerPath(record);
    if (!(await lstat(container)).isDirectory() || (await realpath(container)) !== container)
      fail("storage_uncertain", "Destination staging container changed");
  }

  private async readBundle(
    record: DestinationHandoffStatus,
    archive: VerifiedHandoffArchive,
  ): Promise<VerifiedHandoffBundle> {
    if (!record.binding) fail("invalid_state", "Destination content is not bound");
    return readHandoffBundle(archive, {
      sourceServerId: record.sourceServerId,
      sourceWorkspaceId: record.sourceWorkspaceId,
      sourceAgentIds: record.sourceAgentIds,
      manifestDigest: record.binding.manifest.entrypoint.sha256,
    });
  }

  private async verifyStaging(record: DestinationHandoffStatus): Promise<void> {
    await this.assertContainer(record);
    await this.options.archives.withVerifiedArchive(record.transferId, async (archive) => {
      const content = await this.readBundle(record, archive);
      await this.verifyContents(record, archive, content);
    });
  }

  private async verifyContents(
    record: DestinationHandoffStatus,
    archive: VerifiedHandoffArchive,
    content: VerifiedHandoffBundle,
  ): Promise<void> {
    await verifyWorkspaceFromArchive({
      archive,
      entrypoint: content.bundle.workspace,
      cwd: record.stagingCwd,
    });
    for (const mapping of record.agentMappings) {
      const manifest = content.sessions.get(mapping.sourceAgentId);
      const prepared = record.preparedConversations.find(
        (item) => item.sourceAgentId === mapping.sourceAgentId,
      );
      if (
        !manifest ||
        !prepared ||
        prepared.sessionId !== manifest.sessionId ||
        !record.claudeRuntime
      )
        fail("unprepared_conversations", "Conversation installation is incomplete");
      await verifyClaudeSessionInstallation({
        configDir: record.claudeRuntime.configDir,
        importId: mapping.destinationAgentId,
        manifest,
      });
    }
  }

  private assertHealthy(): void {
    if (!this.initialized || this.uncertain)
      fail("storage_uncertain", "Destination journal must be recovered before continuing");
  }
  private requireRecord(transferId: string): DestinationHandoffStatus {
    this.assertHealthy();
    HandoffTransferIdSchema.parse(transferId);
    const record = this.records.get(transferId);
    if (!record) fail("not_found", "Destination reservation not found");
    return record;
  }
  private async save(record: DestinationHandoffStatus): Promise<void> {
    this.records.set(record.transferId, record);
    await this.persist();
  }
  private async persist(): Promise<void> {
    try {
      const journal = {
        version: 1,
        serverId: this.options.serverId,
        records: [...this.records.values()],
      };
      if (Buffer.byteLength(JSON.stringify(journal)) > 20 * 1024 * 1024)
        fail("invalid_state", "Destination journal exceeded its byte limit");
      await (this.options.write ?? writeJournal)(this.journal, journal);
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new HandoffDestinationError("invalid_state", "Destination preparation service is stopping"),
      );
    const next = this.tail.then(() => {
      this.assertHealthy();
      return operation();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(filePath);
    else if (entry.isFile()) {
      const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }
  await syncDirectory(directory);
}
