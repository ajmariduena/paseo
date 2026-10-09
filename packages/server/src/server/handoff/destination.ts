import { createPublicKey, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HandoffArchiveManifestSchema, HandoffTransferIdSchema } from "@getpaseo/protocol/handoff";
import type { HandoffArchiveStore } from "./archive.js";
import { readBoundedFile, syncDirectory, writeJournal } from "./artifacts.js";
import { verifyHandoffRelease, type HandoffReleaseReceipt } from "./ownership.js";
import {
  HandoffWorkspaceError,
  restoreWorkspaceArchive,
  verifyWorkspaceArchive,
} from "./workspace.js";
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
      const record = this.requireRecord(transferId);
      if (record.sourceAgentIds.length > 0)
        fail(
          "unprepared_conversations",
          "Prepare every conversation artifact before staging this handoff",
        );
      if (!record.binding || record.state === "cancelled")
        fail("invalid_state", "Destination cannot stage this transfer");
      await this.assertContainer(record);
      if (record.state === "staged" || record.state === "released") {
        try {
          await this.verifyStaging(record);
          return structuredClone(record);
        } catch (error) {
          const changed = error instanceof HandoffWorkspaceError && error.code === "source_changed";
          if (!changed && !isMissing(error)) throw error;
        }
      }
      // Only this reservation's private checkout can be replaced after an interrupted restore.
      await rm(record.stagingCwd, { recursive: true, force: true });
      await restoreWorkspaceArchive({
        store: this.options.archives,
        transferId,
        destination: record.stagingCwd,
        expectedManifestDigest: record.binding.manifest.entrypoint.sha256,
      });
      await syncTree(record.stagingCwd);
      await syncDirectory(containerPath(record));
      await this.save({ ...record, state: record.state === "released" ? "released" : "staged" });
      return this.status(transferId);
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
    const sourceIds = record.agentMappings.map((mapping) => mapping.sourceAgentId);
    if (
      JSON.stringify(sourceIds) !== JSON.stringify(record.sourceAgentIds) ||
      new Set(sourceIds).size !== sourceIds.length
    )
      fail("storage_uncertain", "Invalid destination agent mappings");
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

  private async verifyStaging(record: DestinationHandoffStatus): Promise<void> {
    if (!record.binding) fail("invalid_state", "Destination content is not bound");
    await this.assertContainer(record);
    await verifyWorkspaceArchive({
      store: this.options.archives,
      transferId: record.transferId,
      cwd: record.stagingCwd,
      expectedManifestDigest: record.binding.manifest.entrypoint.sha256,
    });
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
