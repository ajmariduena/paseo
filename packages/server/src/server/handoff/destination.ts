import {
  HandoffStoppedWorkReviewSchema,
  HandoffConversationModesSchema,
  handoffConversationMode,
  HandoffIntegrationReviewSchema,
  HandoffCancellationProofSchema,
} from "@getpaseo/protocol/handoff-control";
import { createPublicKey, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  HandoffArchiveManifestSchema,
  HandoffTransferIdSchema,
  HandoffDigestSchema,
} from "@getpaseo/protocol/handoff";
import type { HandoffArchiveStore, VerifiedHandoffArchive } from "./archive.js";
import { readBoundedFile, syncDirectory, writeJournal } from "./artifacts.js";
import {
  verifyHandoffRelease,
  verifyHandoffCancellation,
  handoffPathsOverlap,
  type HandoffMutationScope,
  type HandoffReleaseReceipt,
} from "./ownership.js";
import {
  HandoffWorkspaceError,
  readWorkspaceFromArchive,
  restoreWorkspaceFromArchive,
  verifyWorkspaceFromArchive,
} from "./workspace.js";
import {
  readHandoffBundle,
  readTransferredConversation,
  type VerifiedHandoffBundle,
} from "./bundle.js";
import { fetchHandoffHistory } from "./history.js";
import type { SessionInboundMessage } from "@getpaseo/protocol/messages";
import {
  installClaudeSessionArchive,
  verifyClaudeSessionInstallation,
  removeClaudeSessionInstallation,
  claudeNativeHandoffReason,
} from "../agent/providers/claude/handoff.js";
import { generateProjectId, generateWorkspaceId } from "../workspace-registry-model.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createProviderEnv } from "../agent/provider-launch-config.js";
import { resolveClaudeCodeVersion } from "../agent/providers/claude/agent.js";
import { claudeConfigDir } from "../agent/providers/claude/project-dir.js";

import type { HandoffPublication } from "./publication.js";
import { handoffContextFiles } from "./context.js";
import type {
  HandoffConversationPreview,
  HandoffDestinationPreview,
  HandoffDestinationPage,
} from "@getpaseo/protocol/handoff-control";

const ReservationSchema = z.object({
  transferId: HandoffTransferIdSchema,
  sourceServerId: z.string().min(1),
  sourceWorkspaceId: z.string().min(1),
  sourceAgentIds: z.array(z.string().min(1)).max(1000),
  destinationParent: z.string().min(1),
  continuationMode: z.enum(["native", "context"]).default("native"),
  conversationModes: HandoffConversationModesSchema.optional(),
  workspaceReviewDigest: HandoffDigestSchema.optional(),
  stoppedWorkReview: HandoffStoppedWorkReviewSchema.optional(),
  integrationReview: HandoffIntegrationReviewSchema.optional(),
});
const BindingSchema = z.object({
  publicKey: z.string().min(1).max(1024),
  manifest: HandoffArchiveManifestSchema,
});
const ClaudeRuntimeSchema = z.object({
  configDir: z.string().min(1),
  cliVersion: z.string().regex(/^2\.1\.\d+$/),
});
const PreparedConversationSchema = z.discriminatedUnion("mode", [
  z.object({
    sourceAgentId: z.string().min(1),
    title: z.string().max(4096).nullable(),
    mode: z.literal("native").default("native"),
    sessionId: z.string().uuid(),
    // COMPAT(handoffPublishedRuntime): added in v0.11.1, remove after 2027-02-06 once older activations expire. Omit for old journals to preserve idempotent publication.
    runtime: ClaudeRuntimeSchema.optional(),
  }),
  z.object({
    sourceAgentId: z.string().min(1),
    title: z.string().max(4096).nullable(),
    mode: z.literal("context"),
  }),
]);
const RecordSchema = ReservationSchema.extend({
  reservationId: HandoffTransferIdSchema,
  workspaceId: z.string().regex(/^wks_[a-f0-9]{16}$/),
  projectId: z.string().regex(/^prj_[a-f0-9]{16}$/),
  agentMappings: z
    .array(z.object({ sourceAgentId: z.string().min(1), destinationAgentId: z.string().uuid() }))
    .max(1000),
  destinationCwd: z.string().min(1),
  stagingCwd: z.string().min(1),
  state: z.enum([
    "reserved",
    "receiving",
    "staged",
    "released",
    "activating",
    "active",
    "cancelled",
  ]),
  activationAt: z.string().datetime().nullable().default(null),
  checkoutIdentity: z.object({ dev: z.string(), ino: z.string() }).nullable().default(null),
  binding: BindingSchema.nullable(),
  receipt: z.unknown().nullable(),
  cancellationProof: HandoffCancellationProofSchema.nullable().default(null),
  cleanupComplete: z.boolean().default(false),
  claudeRuntime: ClaudeRuntimeSchema.nullable().default(null),
  preparedConversations: z.array(PreparedConversationSchema).max(1000).default([]),
});
const JournalSchema = z.object({
  version: z.literal(1),
  serverId: z.string().min(1),
  records: z.array(RecordSchema).max(10_000),
});
export type DestinationHandoffStatus = z.infer<typeof RecordSchema>;
type ReservationInput = z.input<typeof ReservationSchema>;
type SourceBinding = z.infer<typeof BindingSchema>;
type ConversationHistoryRequest = Extract<
  SessionInboundMessage,
  { type: "workspace.handoff.get_conversation_history.request" }
>;
interface BindSourceInput extends SourceBinding {
  transferId: string;
}
interface DestinationOptions {
  directory: string;
  serverId: string;
  archives: HandoffArchiveStore;
  write?: typeof writeJournal;
  publication?: HandoffPublication;
  resolveClaudeRuntime?: () => Promise<z.infer<typeof ClaudeRuntimeSchema>>;
}

interface DaemonDestinationOptions extends Omit<DestinationOptions, "resolveClaudeRuntime"> {
  getProviderRuntimeSettings: ProviderSnapshotManager["getProviderRuntimeSettings"];
}

export function createHandoffDestination(options: DaemonDestinationOptions): HandoffDestination {
  return new HandoffDestination({
    ...options,
    resolveClaudeRuntime: async () => {
      const runtimeSettings = options.getProviderRuntimeSettings("claude");
      const env = createProviderEnv({ runtimeSettings });
      return {
        configDir: path.resolve(claudeConfigDir(env)),
        cliVersion: await resolveClaudeCodeVersion(runtimeSettings),
      };
    },
  });
}

export class HandoffDestinationError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "invalid_state"
      | "invalid_release"
      | "invalid_cancellation"
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

/** Preparation stays private; activation publishes closed records after durable source release. */
export class HandoffDestination {
  private readonly records = new Map<string, DestinationHandoffStatus>();
  private readonly identityOwners = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private uncertain = false;
  private closing = false;
  private readonly journal: string;

  constructor(private readonly options: DestinationOptions) {
    this.journal = path.join(options.directory, "destination.json");
  }

  async preview(conversations: HandoffConversationPreview[]): Promise<HandoffDestinationPreview> {
    let destinationVersion: string | null = null;
    let unavailable: string | null = null;
    if (conversations.some((conversation) => conversation.state === "available")) {
      try {
        if (!this.options.resolveClaudeRuntime)
          throw new Error("Claude is unavailable on the destination host");
        destinationVersion = (await this.options.resolveClaudeRuntime()).cliVersion;
      } catch (error) {
        unavailable =
          error instanceof Error ? error.message : "Destination provider could not be inspected";
      }
    }
    return {
      supportsConversationModes: true,
      conversations: conversations.map((conversation) => {
        const identity = {
          agentId: conversation.agentId,
          title: conversation.title,
          provider: conversation.provider,
        };
        const reason = conversation.state === "blocked" ? conversation.reason : unavailable;
        if (reason !== null || destinationVersion === null || conversation.state === "blocked") {
          const blocked = {
            available: false,
            reason: reason ?? "Destination provider is unavailable",
          };
          return { ...identity, native: blocked, context: blocked };
        }
        const nativeReason =
          conversation.nativeUnavailableReason ??
          claudeNativeHandoffReason({
            sourceVersion: conversation.cliVersion,
            destinationVersion,
            hasWorkflows: conversation.hasWorkflows,
          });
        return {
          ...identity,
          native: { available: nativeReason === null, reason: nativeReason },
          context: { available: true, reason: null },
        };
      }),
    };
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
      for (const [id, record] of loaded) {
        this.records.set(id, record);
        this.indexIdentities(record);
      }
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
      const conversationModes = request.conversationModes?.toSorted((left, right) =>
        left.sourceAgentId.localeCompare(right.sourceAgentId),
      );
      const canonical = { ...request, sourceAgentIds, destinationParent, conversationModes };
      this.validateConversationModes(canonical, "invalid_state");
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
        cancellationProof: null,
        cleanupComplete: false,
        activationAt: null,
        checkoutIdentity: null,
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
      if (record.state === "active") return structuredClone(record);
      if (record.state === "activating")
        fail("invalid_state", "Finish destination activation before preparing again");
      if (!record.binding || record.state === "cancelled")
        fail("invalid_state", "Destination cannot stage this transfer");
      await this.assertContainer(record);
      return this.options.archives.withVerifiedArchive(transferId, async (archive) => {
        const content = await this.readBundle(record, archive);
        if (
          record.sourceAgentIds.some((id) => handoffConversationMode(record, id) === "native") &&
          record.claudeRuntime === null
        ) {
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
          additionalFiles: this.contextFiles(record, content),
        });
        const preparedConversations: DestinationHandoffStatus["preparedConversations"] = [];
        for (const conversation of content.bundle.conversations) {
          if (handoffConversationMode(record, conversation.sourceAgentId) === "context") {
            preparedConversations.push({
              sourceAgentId: conversation.sourceAgentId,
              title: conversation.title,
              mode: "context",
            });
            continue;
          }
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
            mode: "native",
            sessionId: handle.sessionId,
            runtime: record.claudeRuntime,
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
      if (!["staged", "released", "activating", "active"].includes(record.state))
        fail("invalid_state", "Destination is not ready for release");
      if (!this.validReceipt(record, receipt))
        fail("invalid_release", "Release does not match the reserved host, key and content");
      if (record.state === "activating" || record.state === "active")
        return structuredClone(record);
      await this.verifyStaging(record);
      if (record.state !== "released") {
        await this.save({ ...record, state: "released", receipt });
      }
      return this.status(transferId);
    });
  }

  /** A retry can reuse the source proof only after this destination has durably accepted it. */
  cancel(transferId: string, proof?: unknown): Promise<DestinationHandoffStatus> {
    return this.serialize(async () => {
      const record = this.requireRecord(transferId);
      if (["released", "activating", "active"].includes(record.state))
        fail("invalid_state", "Released ownership must finish activation");
      const acceptedProof = proof === undefined ? record.cancellationProof : proof;
      if (!this.validCancellation(record, acceptedProof))
        fail(
          "invalid_cancellation",
          "Source cancellation does not match this destination reservation",
        );
      if (record.cleanupComplete) return structuredClone(record);
      const cancelled: DestinationHandoffStatus = {
        ...record,
        state: "cancelled",
        cancellationProof: HandoffCancellationProofSchema.parse(acceptedProof),
      };
      await this.save(cancelled);
      await this.cleanupCancellation(cancelled);
      await this.save({ ...cancelled, cleanupComplete: true });
      return this.status(transferId);
    });
  }

  private validCancellation(record: DestinationHandoffStatus, proof: unknown): boolean {
    return verifyHandoffCancellation(
      proof,
      {
        version: 1,
        outcome: "cancelled",
        transferId: record.transferId,
        sourceServerId: record.sourceServerId,
        destinationServerId: this.options.serverId,
        reservationId: record.reservationId,
      },
      record.binding?.publicKey ?? record.cancellationProof?.publicKey,
    );
  }

  private async cleanupCancellation(record: DestinationHandoffStatus): Promise<void> {
    const claudeRuntime = record.claudeRuntime;
    if (claudeRuntime) {
      await this.options.archives.withVerifiedArchive(record.transferId, async (archive) => {
        const content = await this.readBundle(record, archive);
        for (const mapping of record.agentMappings) {
          if (handoffConversationMode(record, mapping.sourceAgentId) !== "native") continue;
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
      await rm(containerPath(record), { recursive: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    // Also sync an already-missing container: a previous delete may have lost its durable ack.
    await syncDirectory(record.destinationParent);
  }

  isIdentityVisible(id: string): boolean {
    const owner = this.identityOwners.get(id);
    if (!owner) return true;
    return !this.uncertain && this.records.get(owner)?.state === "active";
  }

  assertMutationAllowed(scope: HandoffMutationScope): void {
    for (const record of this.records.values()) {
      if (
        !this.uncertain &&
        (record.state === "active" || (record.state === "cancelled" && record.cleanupComplete))
      )
        continue;
      const identityMatches =
        record.workspaceId === scope.workspaceId ||
        record.agentMappings.some((mapping) => mapping.destinationAgentId === scope.agentId);
      if (
        identityMatches ||
        handoffPathsOverlap(record.destinationCwd, scope.cwd) ||
        handoffPathsOverlap(containerPath(record), scope.cwd)
      ) {
        fail(
          "invalid_state",
          "Destination handoff must finish activation before accepting mutations",
        );
      }
    }
  }

  async recoverActivations(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.state === "activating") await this.activate(record.transferId);
    }
  }

  activate(transferId: string): Promise<DestinationHandoffStatus> {
    return this.serialize(async () => {
      let record = this.requireRecord(transferId);
      const publication = this.options.publication;
      if (!publication) fail("invalid_state", "Destination publication is unavailable");
      if (record.state === "active") {
        await publication.publish(record);
        return structuredClone(record);
      }
      if (record.state !== "released" && record.state !== "activating")
        fail("invalid_state", "Source ownership must be released before activation");
      if (!this.validReceipt(record, record.receipt))
        fail("invalid_release", "Destination has no valid source release");
      if (record.claudeRuntime) {
        if (!this.options.resolveClaudeRuntime)
          fail("unprepared_conversations", "Claude native runtime is unavailable");
        const current = await this.options.resolveClaudeRuntime();
        if (
          current.configDir !== record.claudeRuntime.configDir ||
          current.cliVersion !== record.claudeRuntime.cliVersion
        )
          fail(
            "unprepared_conversations",
            "Destination provider configuration changed after preparation",
          );
      }
      await this.options.archives.withVerifiedArchive(transferId, async (archive) => {
        const content = await this.readBundle(record, archive);
        const workspace = await readWorkspaceFromArchive({
          archive,
          entrypoint: content.bundle.workspace,
        });
        if (record.state === "released") {
          await this.verifyContents(record, archive, content);
          try {
            await lstat(record.destinationCwd);
            fail("conflict", "Destination checkout already exists");
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          const stat = await lstat(record.stagingCwd, { bigint: true });
          record = {
            ...record,
            state: "activating",
            activationAt: new Date().toISOString(),
            checkoutIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
          };
          await this.save(record);
        }
        await this.moveCheckout(record);
        await this.verifyContents(
          { ...record, stagingCwd: record.destinationCwd },
          archive,
          content,
        );
        await publication.install({ record, bundle: content.bundle, workspace });
        record = { ...record, state: "active" };
        await this.save(record);
      });
      await publication.publish(record);
      return structuredClone(record);
    });
  }

  private async moveCheckout(record: DestinationHandoffStatus): Promise<void> {
    const identity = record.checkoutIdentity;
    if (!identity) fail("storage_uncertain", "Destination checkout identity is missing");
    let moved = false;
    try {
      const destination = await lstat(record.destinationCwd, { bigint: true });
      if (
        !destination.isDirectory() ||
        String(destination.dev) !== identity.dev ||
        String(destination.ino) !== identity.ino
      )
        fail("conflict", "Destination checkout is not owned by this handoff");
      moved = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!moved) {
      const staging = await lstat(record.stagingCwd, { bigint: true });
      if (
        !staging.isDirectory() ||
        String(staging.dev) !== identity.dev ||
        String(staging.ino) !== identity.ino
      )
        fail("storage_uncertain", "Private checkout changed before activation");
      await rename(record.stagingCwd, record.destinationCwd);
    }
    await syncDirectory(record.destinationParent);
    await syncDirectory(containerPath(record));
  }

  private indexIdentities(record: DestinationHandoffStatus): void {
    for (const id of [
      record.projectId,
      record.workspaceId,
      ...record.agentMappings.map((mapping) => mapping.destinationAgentId),
    ])
      this.identityOwners.set(id, record.transferId);
  }

  status(transferId: string): DestinationHandoffStatus {
    this.assertHealthy();
    return structuredClone(this.requireRecord(transferId));
  }

  async fetchConversationHistory(input: ConversationHistoryRequest) {
    this.assertHealthy();
    const transferId = this.identityOwners.get(input.agentId);
    const record = transferId ? this.records.get(transferId) : undefined;
    const mapping = record?.agentMappings.find((item) => item.destinationAgentId === input.agentId);
    if (!record || record.state !== "active" || !record.binding || !mapping)
      fail("not_found", "No active transfer contains this destination conversation");
    const { conversation, history, segments, segment } = await readTransferredConversation({
      store: this.options.archives,
      transferId: record.transferId,
      entrypoint: record.binding.manifest.entrypoint,
      sourceAgentId: mapping.sourceAgentId,
      segmentId: input.segmentId,
      expected: {
        sourceServerId: record.sourceServerId,
        sourceWorkspaceId: record.sourceWorkspaceId,
        sourceAgentIds: record.sourceAgentIds,
        manifestDigest: record.binding.manifest.entrypoint.sha256,
      },
    });
    const { rows, startSeq, endSeq, ...page } = fetchHandoffHistory(history, {
      direction: input.cursor ? "before" : "tail",
      cursor: input.cursor,
      limit: input.limit ?? 100,
    });
    return {
      mode: handoffConversationMode(record, mapping.sourceAgentId),
      provider: conversation.provider,
      ...segment.origin,
      segmentId: segment.history.sha256,
      segments: segments.map((item) => ({
        id: item.history.sha256,
        sourceServerId: item.origin.sourceServerId,
        sourceWorkspaceId: item.origin.sourceWorkspaceId,
        sourceAgentId: item.origin.sourceAgentId,
        sourceCwd: item.origin.sourceCwd,
      })),
      title: conversation.title,
      timeline: {
        ...page,
        projection: "projected" as const,
        startCursor: startSeq === null ? null : { epoch: page.epoch, seq: startSeq },
        endCursor: endSeq === null ? null : { epoch: page.epoch, seq: endSeq },
        entries: rows.map((row) => ({
          provider: conversation.provider,
          item: row.item,
          timestamp: row.timestamp,
          seqStart: row.seqStart,
          seqEnd: row.seqEnd,
          sourceSeqRanges: row.sourceSeqRanges,
          collapsed: row.collapsed,
          turnId: row.turnId,
        })),
      },
    };
  }

  list(input: {
    sourceServerId?: string;
    sourceWorkspaceId?: string;
    cursor?: string;
  }): HandoffDestinationPage {
    this.assertHealthy();
    const records = [...this.records.values()]
      .filter(
        (record) =>
          (!input.sourceServerId || record.sourceServerId === input.sourceServerId) &&
          (!input.sourceWorkspaceId || record.sourceWorkspaceId === input.sourceWorkspaceId) &&
          !(record.state === "cancelled" && record.cleanupComplete) &&
          record.state !== "active" &&
          (!input.cursor || record.transferId > input.cursor),
      )
      .sort((left, right) => {
        if (left.transferId < right.transferId) return -1;
        if (left.transferId > right.transferId) return 1;
        return 0;
      });
    const transfers = records
      .slice(0, 20)
      .map(
        ({
          transferId,
          sourceServerId,
          sourceWorkspaceId,
          destinationCwd,
          continuationMode,
          conversationModes,
          state,
        }) => ({
          transferId,
          sourceServerId,
          sourceWorkspaceId,
          destinationCwd,
          continuationMode,
          conversationModes,
          state,
        }),
      );
    return { transfers, nextCursor: records.length > 20 ? transfers[19].transferId : null };
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.tail;
  }

  private validateCancellation(record: DestinationHandoffStatus): void {
    if (
      (record.cancellationProof &&
        (record.state !== "cancelled" ||
          !this.validCancellation(record, record.cancellationProof))) ||
      (record.cleanupComplete && (record.state !== "cancelled" || !record.cancellationProof))
    )
      fail("storage_uncertain", "Destination cancellation journal is inconsistent");
  }

  private validateRecord(record: DestinationHandoffStatus): void {
    this.validateCancellation(record);
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
      (!["released", "activating", "active"].includes(record.state) && record.receipt !== null)
    )
      fail("storage_uncertain", "Destination journal state is inconsistent");
    if (
      ["released", "activating", "active"].includes(record.state) &&
      !this.validReceipt(record, record.receipt)
    )
      fail("storage_uncertain", "Destination release is invalid");
    const activationStarted = record.state === "activating" || record.state === "active";
    if (
      activationStarted !== (record.activationAt !== null) ||
      activationStarted !== (record.checkoutIdentity !== null)
    )
      fail("storage_uncertain", "Destination activation journal is inconsistent");
    this.validateConversationRecords(record);
    const sourceIds = record.agentMappings.map((mapping) => mapping.sourceAgentId);
    if (
      JSON.stringify(sourceIds) !== JSON.stringify(record.sourceAgentIds) ||
      new Set(sourceIds).size !== sourceIds.length
    )
      fail("storage_uncertain", "Invalid destination agent mappings");
  }

  private validateConversationModes(
    record: Pick<DestinationHandoffStatus, "conversationModes" | "sourceAgentIds">,
    code: "invalid_state" | "storage_uncertain",
  ) {
    if (!record.conversationModes) return;
    const ids = record.conversationModes.map((item) => item.sourceAgentId).sort();
    if (
      new Set(ids).size !== ids.length ||
      JSON.stringify(ids) !== JSON.stringify([...record.sourceAgentIds].sort())
    )
      fail(code, "Continuation choices must cover each reserved conversation exactly once");
  }

  private validateConversationRecords(record: DestinationHandoffStatus): void {
    this.validateConversationModes(record, "storage_uncertain");
    for (const conversation of record.preparedConversations) {
      if (conversation.mode !== "native" || !conversation.runtime) continue;
      if (
        conversation.runtime.configDir !== record.claudeRuntime?.configDir ||
        conversation.runtime.cliVersion !== record.claudeRuntime?.cliVersion
      )
        fail("storage_uncertain", "Prepared runtime differs from the destination installation");
    }
    const hasNative = record.sourceAgentIds.some(
      (id) => handoffConversationMode(record, id) === "native",
    );
    if (!hasNative && record.claudeRuntime !== null)
      fail("storage_uncertain", "Context export cannot contain a native runtime installation");
    if (record.claudeRuntime && !path.isAbsolute(record.claudeRuntime.configDir))
      fail("storage_uncertain", "Invalid Claude destination directory");
    const preparedIds = record.preparedConversations.map((item) => item.sourceAgentId).sort();
    if (
      new Set(preparedIds).size !== preparedIds.length ||
      preparedIds.some((id) => !record.sourceAgentIds.includes(id))
    )
      fail("storage_uncertain", "Invalid prepared conversation identities");
    if (
      record.preparedConversations.some(
        (conversation) =>
          conversation.mode !== handoffConversationMode(record, conversation.sourceAgentId),
      )
    )
      fail("storage_uncertain", "Prepared continuation mode differs from the reservation");
    if (["staged", "released", "activating", "active"].includes(record.state)) {
      if (
        JSON.stringify(preparedIds) !== JSON.stringify([...record.sourceAgentIds].sort()) ||
        (hasNative && !record.claudeRuntime)
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
    const content = await readHandoffBundle(archive, {
      sourceServerId: record.sourceServerId,
      sourceWorkspaceId: record.sourceWorkspaceId,
      sourceAgentIds: record.sourceAgentIds,
      manifestDigest: record.binding.manifest.entrypoint.sha256,
    });
    for (const conversation of content.bundle.conversations) {
      if (
        conversation.mode === "context" &&
        handoffConversationMode(record, conversation.sourceAgentId) !== "context"
      )
        fail(
          "unprepared_conversations",
          "This conversation contains exported context, not a local native session",
        );
    }
    return content;
  }

  /** Re-export from the private verified archive, independently of editable workspace copies. */
  hasConversation(agentId: string): boolean {
    this.assertHealthy();
    const transferId = this.identityOwners.get(agentId);
    const record = transferId ? this.records.get(transferId) : undefined;
    return (
      record?.state === "active" &&
      record.agentMappings.some((item) => item.destinationAgentId === agentId)
    );
  }

  async withConversationArchive<T>(
    agentId: string,
    consume: (input: {
      transferId: string;
      reservationId: string;
      sourceAgentId: string;
      continuationMode: "native" | "context";
      archive: VerifiedHandoffArchive;
      content: VerifiedHandoffBundle;
    }) => Promise<T>,
  ): Promise<T> {
    this.assertHealthy();
    const transferId = this.identityOwners.get(agentId);
    const record = transferId ? this.records.get(transferId) : undefined;
    const mapping = record?.agentMappings.find((item) => item.destinationAgentId === agentId);
    if (!record || record.state !== "active" || !record.binding || !mapping)
      fail("not_found", "No active transfer contains this destination conversation");
    return this.options.archives.withVerifiedArchive(record.transferId, async (archive) =>
      consume({
        transferId: record.transferId,
        reservationId: record.reservationId,
        sourceAgentId: mapping.sourceAgentId,
        continuationMode: handoffConversationMode(record, mapping.sourceAgentId),
        archive,
        content: await this.readBundle(record, archive),
      }),
    );
  }

  private async verifyStaging(record: DestinationHandoffStatus): Promise<void> {
    await this.assertContainer(record);
    await this.options.archives.withVerifiedArchive(record.transferId, async (archive) => {
      const content = await this.readBundle(record, archive);
      await this.verifyContents(record, archive, content);
    });
  }

  private contextFiles(record: DestinationHandoffStatus, content: VerifiedHandoffBundle) {
    const withPrevious = new Set(
      content.bundle.conversations
        .filter((item) => item.previous?.length)
        .map((item) => item.sourceAgentId),
    );
    return handoffContextFiles({
      content,
      reservationId: record.reservationId,
      agentMappings: record.agentMappings.filter(
        (mapping) =>
          handoffConversationMode(record, mapping.sourceAgentId) === "context" ||
          withPrevious.has(mapping.sourceAgentId),
      ),
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
      additionalFiles: this.contextFiles(record, content),
    });
    for (const mapping of record.agentMappings) {
      const manifest = content.sessions.get(mapping.sourceAgentId);
      const prepared = record.preparedConversations.find(
        (item) => item.sourceAgentId === mapping.sourceAgentId,
      );
      if (handoffConversationMode(record, mapping.sourceAgentId) === "context") {
        if (prepared?.mode !== "context")
          fail("unprepared_conversations", "Context export is not prepared");
        continue;
      }
      if (
        !manifest ||
        !prepared ||
        prepared.mode !== "native" ||
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
    if (record.state === "active") {
      // Reads and mutation admission must keep seeing "activating" throughout the durable write.
      const records = [...this.records.values()].map((existing) =>
        existing.transferId === record.transferId ? record : existing,
      );
      await this.persist(records);
      this.records.set(record.transferId, record);
      return;
    }
    this.records.set(record.transferId, record);
    this.indexIdentities(record);
    await this.persist();
  }
  private async persist(records = [...this.records.values()]): Promise<void> {
    try {
      const journal = {
        version: 1,
        serverId: this.options.serverId,
        records,
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
