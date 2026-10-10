import { randomUUID } from "node:crypto";
import { copyFile, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import {
  HandoffArchiveManifestSchema,
  HandoffTransferIdSchema,
  HandoffBlobSchema,
  HandoffDigestSchema,
} from "@getpaseo/protocol/handoff";
import {
  HandoffIntegrationReviewSchema,
  type HandoffIntegrationReview,
  type HandoffConversationPreview,
  type HandoffSourcePreview,
  type HandoffStoppedWorkReview,
} from "@getpaseo/protocol/handoff-control";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "../agent/agent-manager.js";
import {
  RestartCancelledWorkSchema,
  type AgentStorage,
  type StoredAgentRecord,
} from "../agent/agent-storage.js";
import {
  ClaudeSessionRuntimeSchema,
  readClaudeSessionRuntime,
} from "../agent/providers/claude/session-runtime.js";
import {
  captureClaudeSession,
  readCapturedClaudeHistory,
  verifyCapturedClaudeSession,
  previewClaudeSession,
} from "../agent/providers/claude/handoff.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../terminal/terminal.js";
import type { WorkspaceSetupRuntime } from "../workspace-setup-runtime.js";
import type { HandoffArchiveStore } from "./archive.js";
import { readBoundedFile, syncDirectory, writeJournal } from "./artifacts.js";
import {
  captureWorkspace,
  verifyCapturedWorkspace,
  previewWorkspace,
  listWorkspaceOmissions,
} from "./workspace.js";
import {
  packHandoffArchive,
  readHandoffBundle,
  HandoffHistoryOriginSchema,
  handoffConversationOrigin,
  type CapturedConversation,
  type CapturedPreviousSegment,
  type HandoffBundle,
} from "./bundle.js";
import { HandoffContextSchema, handoffContextDirectory } from "./context.js";
import { HandoffHistorySegmentSchema, HANDOFF_PREVIOUS_SEGMENTS_MAX } from "./history-segments.js";
import type { HandoffDestination } from "./destination.js";
import {
  writeHandoffHistory,
  readHandoffHistory,
  fetchHandoffHistory,
  HandoffHistorySchema,
} from "./history.js";
import type { AgentTimelineFetchOptions } from "../agent/agent-timeline-store-types.js";
import {
  handoffPathsOverlap,
  type HandoffOwnership,
  type SourceHandoffStatus,
  type HandoffCancellationInput,
} from "./ownership.js";

const AgentIdentitySchema = z.object({
  id: z.string().min(1),
  recordRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  cwd: z.string().min(1),
  title: z.string().nullable(),
  pendingRestartNote: z.array(RestartCancelledWorkSchema).max(1024).optional(),
});
const NativeAgentSchema = AgentIdentitySchema.extend({
  // COMPAT(handoffSourceMode): added in v0.11.1, remove after 2027-04-10 once retained native preparations include a mode.
  mode: z.literal("native").optional(),
  sessionId: z.string().uuid(),
  projectDirName: z.string().optional(),
  // COMPAT(handoffCapturedRuntime): added in v0.11.1, remove after 2027-02-06 once older prepared transfers expire.
  runtime: ClaudeSessionRuntimeSchema.optional(),
  context: HandoffContextSchema.optional(),
  previous: z.array(HandoffHistorySegmentSchema).max(HANDOFF_PREVIOUS_SEGMENTS_MAX).optional(),
  previousBinding: z
    .object({ transferId: HandoffTransferIdSchema, manifestDigest: HandoffDigestSchema })
    .optional(),
});
const ContextAgentSchema = AgentIdentitySchema.extend({
  mode: z.literal("context"),
  context: HandoffContextSchema,
  previousTransferId: HandoffTransferIdSchema,
  previousManifestDigest: HandoffDigestSchema,
  session: HandoffBlobSchema,
  origin: HandoffHistoryOriginSchema,
  previous: z.array(HandoffHistorySegmentSchema).max(HANDOFF_PREVIOUS_SEGMENTS_MAX).optional(),
});
const AgentSchema = z.discriminatedUnion("mode", [NativeAgentSchema, ContextAgentSchema]);
const PreparedSchema = z.object({
  // COMPAT(handoffPreparedHistory): added in v0.11.1, remove after 2027-04-10 once retained v1/v2 preparations finish.
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  transferId: HandoffTransferIdSchema,
  cwd: z.string().min(1),
  agents: z.array(AgentSchema).max(1000),
  runtime: z.object({ configDir: z.string().min(1), cliVersion: z.string().min(1) }).nullable(),
  manifest: HandoffArchiveManifestSchema,
});
type PreparedSource = z.infer<typeof PreparedSchema>;
interface SourceOptions {
  directory: string;
  serverId: string;
  logger: Logger;
  ownership: HandoffOwnership;
  archives: HandoffArchiveStore;
  destination: Pick<HandoffDestination, "withConversationArchive" | "hasConversation">;
  workspaces: Pick<WorkspaceRegistry, "get" | "list">;
  agents: AgentStorage;
  agentManager: Pick<
    AgentManager,
    | "getAgent"
    | "listAgents"
    | "closeAgent"
    | "projectHistoryForHandoff"
    | "checkpointPromptAnnotations"
  >;
  terminals: Pick<TerminalManager, "listDirectories" | "getTerminals" | "killTerminalAndWait">;
  setup: Pick<WorkspaceSetupRuntime, "stop" | "activeIds">;
  onWorkspaceChanged?: (workspaceId: string) => Promise<void>;
}
interface SourceRequest {
  transferId: string;
  workspaceId: string;
  agentIds: string[];
  destinationServerId: string;
  reservationId: string;
  workspaceReviewDigest?: string;
  stoppedWorkReview?: HandoffStoppedWorkReview;
  integrationReview?: HandoffIntegrationReview;
}

function verifyCapturedRecord(
  record: StoredAgentRecord,
  captured: PreparedSource["agents"][number],
) {
  if (captured.mode === "context") {
    if (record.persistence || !isDeepStrictEqual(record.handoffContext, captured.context))
      refuse("source_changed", "Source carried context changed after capture");
  } else if (
    record.persistence?.sessionId !== captured.sessionId ||
    record.persistence?.metadata?.claudeProjectDirName !== captured.projectDirName ||
    !isDeepStrictEqual(record.handoffContext, captured.context)
  ) {
    refuse("source_changed", "Source conversation changed after capture");
  }
  if (!isDeepStrictEqual(record.pendingRestartNote ?? [], captured.pendingRestartNote ?? []))
    refuse("source_changed", "Pending restart notes changed after capture");
  // COMPAT(handoffRecordRevision): added in v0.11.1, remove after 2027-04-10 once v1/v2 preparations finish.
  if (captured.recordRevision !== undefined && record.revision !== captured.recordRevision)
    refuse("source_changed", "Source conversation record changed after capture");
}

export class HandoffSourceError extends Error {
  constructor(
    readonly code:
      | "invalid_source"
      | "inventory_changed"
      | "stop_uncertain"
      | "source_changed"
      | "review_changed",
    message: string,
  ) {
    super(message);
    this.name = "HandoffSourceError";
  }
}
function refuse(code: HandoffSourceError["code"], message: string): never {
  throw new HandoffSourceError(code, message);
}
function sameIds(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** Owns the source-side order: fence, stop, drain, persist, capture, then certify readiness. */
export class HandoffSource {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly writerInstances = new WeakMap<object, string>();
  private closing = false;
  constructor(private readonly options: SourceOptions) {}

  async inspect(workspaceId: string) {
    const { records, ...inventory } = await this.inventory(workspaceId);
    for (const record of records) {
      const reason = this.conversationBlockReason(record);
      if (reason) refuse(reason.code, reason.message);
    }
    return inventory;
  }

  async preview(workspaceId: string): Promise<HandoffSourcePreview> {
    const inventory = await this.inventory(workspaceId);
    const records = new Map(inventory.records.map((record) => [record.id, record]));
    const conversations: HandoffConversationPreview[] = [];
    for (const agentId of inventory.agentIds) {
      const record = records.get(agentId);
      const live = this.options.agentManager.getAgent(agentId);
      const identity = {
        agentId,
        title: record?.title ?? null,
        provider: record?.provider ?? live?.provider ?? "unknown",
      };
      try {
        if (!record)
          refuse("invalid_source", "Conversation has not finished saving; retry the review");
        const reason = this.conversationBlockReason(record);
        if (reason) refuse(reason.code, reason.message);
        const current = {
          ...record,
          persistence: live?.session?.describePersistence() ?? record.persistence,
        };
        if (!current.persistence) {
          const { preview } = await this.contextAgent(current);
          conversations.push({ ...identity, provider: "claude", state: "available", ...preview });
          continue;
        }
        const agent = this.nativeAgent(current);
        const previous = await this.previousSegments(current, agent.sessionId);
        const preview = await previewClaudeSession({
          handle: {
            provider: "claude",
            sessionId: agent.sessionId,
            metadata: { claudeProjectDirName: agent.projectDirName },
          },
          cwd: agent.cwd,
          ...agent.runtime,
        });
        conversations.push({
          ...identity,
          provider: "claude",
          state: "available",
          ...preview,
          artifactBytes:
            preview.artifactBytes +
            previous.previous.reduce(
              (sum, item) =>
                sum + item.manifest.files.reduce((bytes, file) => bytes + file.blob.size, 0),
              0,
            ),
        });
      } catch (error) {
        conversations.push({
          ...identity,
          state: "blocked",
          reason: error instanceof Error ? error.message : "Source session could not be inspected",
        });
      }
    }
    const workspace = await previewWorkspace({ cwd: inventory.cwd });
    const terminals = await this.sourceTerminals(inventory);
    const review = this.reviewWriters(inventory, terminals);
    return {
      workspaceId,
      cwd: inventory.cwd,
      conversations,
      integrationReview: this.reviewIntegrations(inventory.records),
      workspace,
      stoppedWork: {
        agentIds: review.agents.map(({ id }) => id),
        terminals: terminals.map((terminal) => ({ id: terminal.id, name: terminal.name })),
        setupOperations: review.setupIds.length,
        review,
      },
    };
  }

  async listOmissions(input: { workspaceId: string; reviewDigest: string; offset: number }) {
    const inventory = await this.inventory(input.workspaceId);
    return listWorkspaceOmissions({ ...input, cwd: inventory.cwd });
  }

  private conversationBlockReason(record: StoredAgentRecord) {
    if (
      record.provider !== "claude" ||
      record.archivedAt ||
      record.owner ||
      record.labels[PARENT_AGENT_ID_LABEL]
    )
      return {
        code: "invalid_source" as const,
        message: "This conversation requires a handoff disposition that is not implemented yet",
      };
    if (record.lastStatus !== "closed" && !this.options.agentManager.getAgent(record.id))
      return {
        code: "stop_uncertain" as const,
        message: "Source runtime exit has not been confirmed",
      };
    return null;
  }

  private async inventory(workspaceId: string) {
    const workspace = await this.options.workspaces.get(workspaceId);
    if (!workspace || workspace.archivedAt)
      refuse("invalid_source", "Source workspace is unavailable");
    const cwd = await realpath(workspace.cwd);
    const records = await this.options.agents.listByWorkspaceForHandoff(workspaceId);
    const live = this.options.agentManager.listAgents();
    const ids = [
      ...new Set([
        ...records.map((record) => record.id),
        ...live.filter((agent) => agent.workspaceId === workspaceId).map((agent) => agent.id),
      ]),
    ].sort();
    for (const other of await this.options.workspaces.list()) {
      if (
        other.workspaceId !== workspaceId &&
        !other.archivedAt &&
        handoffPathsOverlap(cwd, await realpath(other.cwd))
      )
        refuse("invalid_source", "Another workspace shares the source checkout");
    }
    for (const agent of live) {
      if (agent.workspaceId !== workspaceId && handoffPathsOverlap(cwd, await realpath(agent.cwd)))
        refuse("invalid_source", "Another agent writes to the source checkout");
    }
    return { cwd, workspaceId, agentIds: ids, records };
  }

  prepare(input: SourceRequest) {
    return this.serialize(async () => {
      HandoffTransferIdSchema.parse(input.transferId);
      const inventory = await this.inspect(input.workspaceId);
      if (!sameIds(inventory.agentIds, input.agentIds))
        refuse(
          "inventory_changed",
          "Source conversation set changed after destination reservation",
        );
      if (input.workspaceReviewDigest) {
        const current = await previewWorkspace({ cwd: inventory.cwd });
        if (current.reviewDigest !== input.workspaceReviewDigest)
          refuse(
            "review_changed",
            "Workspace files or exclusions changed after review; cancel this transfer and review again",
          );
      }
      if (
        input.stoppedWorkReview &&
        this.options.ownership.forWorkspace(input.workspaceId)?.id !== input.transferId
      ) {
        const current = this.reviewWriters(inventory, await this.sourceTerminals(inventory));
        if (JSON.stringify(current) !== JSON.stringify(input.stoppedWorkReview))
          refuse(
            "review_changed",
            "Work that will stop changed after review; cancel this transfer and review again",
          );
      }
      this.assertReviewedIntegrations(
        input.integrationReview,
        await this.options.agents.listByWorkspaceForHandoff(input.workspaceId),
      );
      let source = await this.options.ownership.prepare({
        id: input.transferId,
        ...inventory,
        destinationServerId: input.destinationServerId,
        reservationId: input.reservationId,
        workspaceReviewDigest: input.workspaceReviewDigest,
        stoppedWorkReview: input.stoppedWorkReview,
        integrationReview: input.integrationReview,
      });
      await this.publishTransfer(input.transferId);
      if (source.state === "cancelled")
        refuse("invalid_source", "Cancelled source transfer cannot be prepared");
      if (source.state === "ready" || source.state === "released") {
        const prepared = await this.readPrepared(source);
        await this.verify(source, prepared);
        return { source, manifest: prepared.manifest };
      }
      // Setup and provider commands may hold admission leases until cancellation settles.
      await this.stopWriters(source);
      await this.options.ownership.drain(source.id);
      const finalInventory = await this.inspect(source.workspaceId);
      if (!sameIds(finalInventory.agentIds, source.agentIds))
        refuse("inventory_changed", "Source conversation set changed while draining admitted work");
      await this.stopWriters(source);
      const records: StoredAgentRecord[] = [];
      for (const id of source.agentIds) {
        await this.options.agentManager.checkpointPromptAnnotations(id);
        records.push(await this.options.agents.checkpointClosedAgent(id));
      }
      this.assertReviewedIntegrations(source.integrationReview, records);
      const agents: PreparedSource["agents"] = [];
      const directory = this.captureDirectory(source.id);
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { mode: 0o700 });
      await syncDirectory(this.options.directory);
      const workspaceDirectory = path.join(directory, "workspace");
      await captureWorkspace({
        cwd: source.cwd,
        artifactDirectory: workspaceDirectory,
        expectedReviewDigest: source.workspaceReviewDigest,
      });
      const conversations: CapturedConversation[] = [];
      for (const [index, record] of records.entries()) {
        const artifactDirectory = path.join(directory, `conversation-${index}`);
        const historyPath = path.join(directory, `history-${index}.json`);
        if (!record.persistence) {
          const { agent, previous } = await this.contextAgent(record, {
            artifactDirectory,
            historyPath,
          });
          agents.push(agent);
          conversations.push({
            sourceAgentId: agent.id,
            title: agent.title,
            artifactDirectory,
            historyPath,
            pendingRestartNote: agent.pendingRestartNote,
            mode: "context",
            origin: agent.origin,
            previous,
          });
          continue;
        }
        const native = this.nativeAgent(record);
        const { previous, binding } = await this.previousSegments(record, native.sessionId);
        const agent = NativeAgentSchema.parse({
          ...native,
          runtime: native.runtime,
          ...(record.handoffContext ? { context: record.handoffContext } : {}),
          ...(binding ? { previousBinding: binding } : {}),
          ...(previous.length ? { previous: previous.map((item) => item.segment) } : {}),
        });
        agents.push(agent);
        await captureClaudeSession(this.captureInput(agent, native.runtime, artifactDirectory));
        const events = await readCapturedClaudeHistory({
          artifactDirectory,
          cwd: agent.cwd,
          logger: this.options.logger,
        });
        const rows = await this.options.agentManager.projectHistoryForHandoff(
          agent.id,
          events,
          records[index].createdAt,
        );
        await writeHandoffHistory(historyPath, {
          version: 1,
          sourceAgentId: agent.id,
          epoch: source.id,
          promptAnnotations: records[index].promptAnnotations,
          rows,
        });
        conversations.push({
          sourceAgentId: agent.id,
          title: agent.title,
          artifactDirectory,
          historyPath,
          pendingRestartNote: agent.pendingRestartNote,
          previous,
        });
      }
      const manifest = await packHandoffArchive({
        store: this.options.archives,
        transferId: source.id,
        sourceServerId: this.options.serverId,
        sourceWorkspaceId: source.workspaceId,
        sourceCwd: source.cwd,
        workspaceDirectory,
        conversations,
      });
      const prepared: PreparedSource = {
        version: 3,
        transferId: source.id,
        cwd: source.cwd,
        agents,
        runtime: null,
        manifest,
      };
      await writeJournal(path.join(directory, "source.json"), prepared);
      await this.verify(source, prepared);
      source = await this.options.ownership.markReady(source.id, manifest.entrypoint.sha256);
      return { source, manifest };
    }).finally(() => this.publishTransfer(input.transferId));
  }

  async status(transferId: string) {
    const source = this.options.ownership.status(transferId);
    const captured = source.state === "ready" || source.state === "released";
    const manifest = captured ? (await this.readPrepared(source)).manifest : null;
    return { source, manifest };
  }

  async recoveryStatus(transferId: string) {
    const cancellation = this.options.ownership.cancellation(transferId);
    try {
      return { result: await this.status(transferId), cancellation };
    } catch (error) {
      // Cancellation can precede preparation, leaving a tombstone without a workspace snapshot.
      if (cancellation && error instanceof Error && "code" in error && error.code === "not_found")
        return { result: null, cancellation };
      throw error;
    }
  }

  findWorkspace(workspaceId: string) {
    // Discovery must still work after the source checkout has been removed.
    return this.options.ownership.forWorkspace(workspaceId);
  }

  workspaceState(workspaceId: string) {
    const source = this.findWorkspace(workspaceId);
    return source
      ? {
          transferId: source.id,
          state: source.state,
          destinationServerId: source.destinationServerId,
        }
      : null;
  }

  private async publishTransfer(transferId: string): Promise<void> {
    if (!this.options.onWorkspaceChanged) return;
    try {
      const source = this.options.ownership.status(transferId);
      await this.options.onWorkspaceChanged(source.workspaceId);
    } catch (error) {
      // Cancellation before preparation has no workspace record to project.
      if (error instanceof Error && "code" in error && error.code === "not_found") return;
      // Ownership is authoritative even if a connected client misses the update;
      // its next workspace snapshot rebuilds the projection from the journal.
      this.options.logger.warn(
        { err: error, transferId },
        "Failed to publish handoff workspace state",
      );
    }
  }

  cancel(input: HandoffCancellationInput) {
    // Do not reopen source admission while its preparation is still stopping or capturing writers.
    return this.serialize(() => this.options.ownership.cancelReservation(input)).finally(() =>
      this.publishTransfer(input.transferId),
    );
  }

  release(transferId: string) {
    return this.serialize(async () => {
      const source = this.options.ownership.status(transferId);
      const prepared = await this.readPrepared(source);
      return this.options.ownership.release(
        transferId,
        {
          version: 1,
          transferId,
          sourceServerId: this.options.serverId,
          destinationServerId: source.destinationServerId,
          reservationId: source.reservationId,
          manifestDigest: prepared.manifest.entrypoint.sha256,
        },
        () => this.verify(source, prepared),
      );
    }).finally(() => this.publishTransfer(transferId));
  }

  async fetchTimeline(agentId: string, options: AgentTimelineFetchOptions) {
    const source = this.options.ownership.forAgent(agentId);
    if (!source) return null;
    if ((source.state !== "ready" && source.state !== "released") || !source.manifestDigest)
      refuse(
        "invalid_source",
        "Handoff history is not ready; retry after source preparation completes",
      );
    const record = await this.options.agents.get(agentId);
    if (!record || record.internal) refuse("invalid_source", "Source conversation is unavailable");
    const manifestDigest = source.manifestDigest;
    const timeline = await this.options.archives.withVerifiedArchive(source.id, async (archive) => {
      const { bundle } = await readHandoffBundle(archive, {
        sourceServerId: this.options.serverId,
        sourceWorkspaceId: source.workspaceId,
        sourceAgentIds: source.agentIds,
        manifestDigest,
      });
      const conversation = bundle.conversations.find(
        (candidate) => candidate.sourceAgentId === agentId,
      );
      if (!conversation?.history)
        refuse("invalid_source", "This transfer does not contain readable history");
      const history = await readHandoffHistory(
        path.join(archive.blobsDirectory, conversation.history.sha256),
        conversation.origin?.sourceAgentId ?? agentId,
      );
      return fetchHandoffHistory(history, options);
    });
    return { record, timeline };
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.tail;
  }

  private async sourceTerminals(source: { workspaceId: string; cwd: string }) {
    const terminals = new Map<string, TerminalSession>();
    for (const directory of this.options.terminals.listDirectories()) {
      for (const terminal of await this.options.terminals.getTerminals(directory)) {
        if (
          terminal.workspaceId === source.workspaceId ||
          handoffPathsOverlap(source.cwd, terminal.cwd)
        )
          terminals.set(terminal.id, terminal);
      }
    }
    if (terminals.size > 1000) refuse("invalid_source", "Too many terminals to review for handoff");
    return [...terminals.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private async stopWriters(source: SourceHandoffStatus): Promise<void> {
    const terminals = await this.sourceTerminals(source);
    this.assertReviewedWriters(source.stoppedWorkReview, this.reviewWriters(source, terminals));
    const stops = [() => this.options.setup.stop(source.workspaceId)];
    for (const id of source.agentIds) {
      const session = this.options.agentManager.getAgent(id)?.session;
      if (session || !source.stoppedWorkReview)
        stops.push(() => this.options.agentManager.closeAgent(id, session ?? undefined));
    }
    for (const terminal of terminals)
      stops.push(() => this.options.terminals.killTerminalAndWait(terminal.id));
    const results = await Promise.allSettled(stops.map(async (stop) => stop()));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Source writers did not all stop; handoff remains fenced",
      );
  }

  private reviewWriters(
    source: { workspaceId: string; agentIds: string[] },
    terminals: TerminalSession[],
  ): HandoffStoppedWorkReview {
    const instanceId = (writer: object) => {
      let id = this.writerInstances.get(writer);
      if (!id) {
        id = randomUUID();
        this.writerInstances.set(writer, id);
      }
      return id;
    };
    const agents = source.agentIds.flatMap((id) => {
      const session = this.options.agentManager.getAgent(id)?.session;
      return session ? [{ id, instanceId: instanceId(session) }] : [];
    });
    const review = {
      agents,
      terminals: terminals.map((terminal) => ({
        id: terminal.id,
        instanceId: instanceId(terminal),
        name: terminal.name,
      })),
      setupIds: this.options.setup.activeIds(source.workspaceId),
    };
    if (review.setupIds.length > 1000)
      refuse("invalid_source", "Too many setup operations to review for handoff");
    return review;
  }

  private assertReviewedWriters(
    approved: HandoffStoppedWorkReview | undefined,
    current: HandoffStoppedWorkReview,
  ) {
    if (!approved) return;
    // Stops and natural exits shrink the set. A retry may not stop a replacement runtime.
    const has = <T>(allowed: T[], values: T[]) => {
      const entries = new Set(allowed.map((value) => JSON.stringify(value)));
      return values.every((value) => entries.has(JSON.stringify(value)));
    };
    if (
      !has(approved.agents, current.agents) ||
      !has(approved.terminals, current.terminals) ||
      !has(approved.setupIds, current.setupIds)
    )
      refuse(
        "review_changed",
        "Work that will stop changed after review; cancel this transfer and review again",
      );
  }

  private reviewIntegrations(records: StoredAgentRecord[]): HandoffIntegrationReview {
    // Only caller-supplied MCP names belong in the review. Commands, URLs, headers and env stay local.
    // Provider-discovered host/project integrations are not part of this inventory.
    const review = records
      .map((record) => ({
        agentId: record.id,
        omittedMcpServers: Object.keys(record.config?.mcpServers ?? {}).sort(),
      }))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    const parsed = HandoffIntegrationReviewSchema.safeParse(review);
    if (!parsed.success)
      refuse("invalid_source", "Conversation integrations exceed the handoff review limits");
    return parsed.data;
  }

  private assertReviewedIntegrations(
    approved: HandoffIntegrationReview | undefined,
    records: StoredAgentRecord[],
  ) {
    if (approved && JSON.stringify(approved) !== JSON.stringify(this.reviewIntegrations(records)))
      refuse(
        "review_changed",
        "Conversation MCP connections changed after review; cancel this transfer and review again",
      );
  }

  private async verifyStoppedConversations(source: SourceHandoffStatus, prepared: PreparedSource) {
    const records = new Map<string, StoredAgentRecord>();
    for (const id of source.agentIds) {
      if (this.options.agentManager.getAgent(id))
        refuse("stop_uncertain", "Source provider runtime is still loaded");
      await this.options.agentManager.checkpointPromptAnnotations(id);
      const record = await this.options.agents.checkpointClosedAgent(id);
      const captured = prepared.agents.find((agent) => agent.id === id);
      if (!record || !captured || record.lastStatus !== "closed" || record.cwd !== captured.cwd)
        refuse("source_changed", "Source conversation changed after capture");
      verifyCapturedRecord(record, captured);
      records.set(id, record);
    }
    return records;
  }

  private async verify(source: SourceHandoffStatus, prepared: PreparedSource): Promise<void> {
    const inventory = await this.inspect(source.workspaceId);
    if (!sameIds(inventory.agentIds, source.agentIds))
      refuse("inventory_changed", "Source conversation inventory changed after capture");
    if (
      (await this.sourceTerminals(source)).length > 0 ||
      this.options.setup.activeIds(source.workspaceId).length > 0
    )
      refuse("stop_uncertain", "Source terminals or setup are still running");
    this.assertReviewedIntegrations(
      source.integrationReview,
      await this.options.agents.listByWorkspaceForHandoff(source.workspaceId),
    );
    const records = await this.verifyStoppedConversations(source, prepared);
    const directory = this.captureDirectory(source.id);
    await verifyCapturedWorkspace({
      cwd: source.cwd,
      artifactDirectory: path.join(directory, "workspace"),
      expectedReviewDigest: source.workspaceReviewDigest,
    });
    for (const [index, agent] of prepared.agents.entries()) {
      const record = records.get(agent.id);
      if (!record) refuse("source_changed", "Captured conversation is missing from the source");
      if (agent.mode === "context") {
        const current = await this.contextAgent(record);
        if (
          !isDeepStrictEqual(
            { ...current.agent, recordRevision: agent.recordRevision },
            { ...agent, recordRevision: agent.recordRevision },
          )
        )
          refuse("source_changed", "Source carried history changed after capture");
        continue;
      }
      const previous = await this.previousSegments(record, agent.sessionId);
      if (
        // COMPAT(handoffPreparedHistory): v1 did not bind a prior native import when it contained no earlier segments.
        (prepared.version >= 2 && !isDeepStrictEqual(previous.binding, agent.previousBinding)) ||
        !isDeepStrictEqual(
          previous.previous.map((item) => item.segment),
          agent.previous ?? [],
        )
      )
        refuse("source_changed", "Earlier conversation history changed after capture");
      // COMPAT(handoffCapturedRuntime): added in v0.11.1, remove after 2027-02-06 once older prepared transfers expire.
      const runtime = agent.runtime ?? prepared.runtime;
      if (!runtime) refuse("invalid_source", "Source provider configuration is missing");
      if (
        agent.runtime &&
        !isDeepStrictEqual(agent.runtime, readClaudeSessionRuntime(record.persistence ?? undefined))
      )
        refuse("source_changed", "Source conversation runtime changed after capture");
      const artifactDirectory = path.join(directory, `conversation-${index}`);
      await verifyCapturedClaudeSession(this.captureInput(agent, runtime, artifactDirectory));
      const history = await readHandoffHistory(
        path.join(directory, `history-${index}.json`),
        agent.id,
      );
      const events = await readCapturedClaudeHistory({
        artifactDirectory,
        cwd: agent.cwd,
        logger: this.options.logger,
      });
      const rows = await this.options.agentManager.projectHistoryForHandoff(
        agent.id,
        events,
        record.createdAt,
      );
      const projected = HandoffHistorySchema.parse({
        ...history,
        promptAnnotations: record.promptAnnotations,
        rows,
      });
      // Compare the persisted representation; optional undefined fields are absent from JSON.
      if (!isDeepStrictEqual(history, JSON.parse(JSON.stringify(projected))))
        refuse("source_changed", "Source conversation history presentation changed after capture");
    }
    await this.options.archives.withVerifiedArchive(source.id, async (archive) => {
      if (archive.manifest.entrypoint.sha256 !== prepared.manifest.entrypoint.sha256)
        refuse("source_changed", "Source archive changed after capture");
      const { bundle } = await readHandoffBundle(archive, {
        sourceServerId: this.options.serverId,
        sourceWorkspaceId: source.workspaceId,
        sourceAgentIds: source.agentIds,
        manifestDigest: prepared.manifest.entrypoint.sha256,
      });
      for (const agent of prepared.agents) {
        const captured = bundle.conversations.find(
          (conversation) => conversation.sourceAgentId === agent.id,
        );
        if (!isDeepStrictEqual(captured?.previous ?? [], agent.previous ?? []))
          refuse("source_changed", "Captured earlier history differs from its verified source");
        if (agent.mode !== "context") continue;
        if (
          captured?.mode !== "context" ||
          !isDeepStrictEqual(captured.history, agent.context.history) ||
          !isDeepStrictEqual(captured.session, agent.session) ||
          !isDeepStrictEqual(captured.origin, agent.origin)
        )
          refuse(
            "source_changed",
            "Captured context differs from the original verified conversation",
          );
      }
    });
  }

  private async contextAgent(
    record: StoredAgentRecord,
    capture?: { artifactDirectory: string; historyPath: string },
  ) {
    if (record.provider !== "claude" || record.persistence || !record.handoffContext?.pending)
      refuse("invalid_source", "Conversation has no saved session or pending exported context");
    if (record.runtimeGeneration || (record.promptAnnotations?.entryCount ?? 0) !== 0)
      refuse(
        "invalid_source",
        "This conversation has local activity that requires a saved provider session",
      );
    return this.options.destination.withConversationArchive(
      record.id,
      async ({ transferId, reservationId, sourceAgentId, continuationMode, archive, content }) => {
        const conversation = content.bundle.conversations.find(
          (item) => item.sourceAgentId === sourceAgentId,
        );
        const session = content.sessions.get(sourceAgentId);
        if (!conversation?.history || !session)
          refuse("invalid_source", "Original exported conversation is incomplete");
        const origin = handoffConversationOrigin(content.bundle, conversation);
        if (continuationMode !== "context")
          refuse("invalid_source", "A native conversation is missing its persistence handle");
        const context = {
          sourceServerId: origin.sourceServerId,
          sourceAgentId: origin.sourceAgentId,
          sourceCwd: origin.sourceCwd,
          directory: handoffContextDirectory(reservationId, record.id),
          history: conversation.history,
          pending: true,
          ...(conversation.historyIndex ? { historyIndex: conversation.historyIndex } : {}),
          // COMPAT(handoffContextMode): added in v0.11.1, remove after 2027-04-10 once retained v1/v2 publications finish.
          ...(content.bundle.version === 3 ? { continuationMode: "context" as const } : {}),
        };
        if (!isDeepStrictEqual(record.handoffContext, context))
          refuse("source_changed", "Carried context differs from its original verified archive");
        const agent = ContextAgentSchema.parse({
          id: record.id,
          recordRevision: record.revision,
          cwd: record.cwd,
          title: record.title ?? null,
          mode: "context",
          context,
          ...(record.pendingRestartNote !== undefined
            ? { pendingRestartNote: record.pendingRestartNote }
            : {}),
          previousTransferId: transferId,
          previousManifestDigest: archive.manifest.entrypoint.sha256,
          session: conversation.session,
          origin,
          ...(conversation.previous?.length ? { previous: conversation.previous } : {}),
        });
        if (capture) {
          const blobs = path.join(capture.artifactDirectory, "blobs");
          await mkdir(blobs, { recursive: true, mode: 0o700 });
          await copyFile(
            path.join(archive.blobsDirectory, conversation.session.sha256),
            path.join(capture.artifactDirectory, "manifest.json"),
          );
          for (const file of session.files)
            await copyFile(
              path.join(archive.blobsDirectory, file.blob.sha256),
              path.join(blobs, file.blob.sha256),
            );
          await copyFile(
            path.join(archive.blobsDirectory, conversation.history.sha256),
            capture.historyPath,
          );
        }
        const previous = (conversation.previous ?? []).map((segment): CapturedPreviousSegment => {
          const manifest = content.previousSessions.get(segment.session.sha256);
          if (!manifest) refuse("invalid_source", "Earlier conversation artifacts are missing");
          return { segment, manifest, blobsDirectory: archive.blobsDirectory };
        });
        return {
          agent,
          previous,
          preview: {
            cliVersion: session.cliVersion,
            hasWorkflows: session.files.some((file) => file.path.startsWith("session/workflows/")),
            artifactBytes: [session, ...previous.map((item) => item.manifest)].reduce(
              (sum, manifest) =>
                sum + manifest.files.reduce((bytes, file) => bytes + file.blob.size, 0),
              0,
            ),
            nativeUnavailableReason:
              "This conversation contains exported context, not a local native session",
          },
        };
      },
    );
  }

  private assertPreviousContext(
    record: StoredAgentRecord,
    bundle: HandoffBundle,
    conversation: HandoffBundle["conversations"][number],
    reservationId: string,
    continuationMode: "native" | "context",
  ) {
    if (continuationMode !== "context" && !conversation.previous?.length) {
      if (record.handoffContext)
        refuse("source_changed", "Unexpected carried context on a native conversation");
      return;
    }
    if (!record.handoffContext || !conversation.history)
      refuse("invalid_source", "Earlier conversation context is missing from the agent record");
    const origin = handoffConversationOrigin(bundle, conversation);
    const expected = {
      sourceServerId: origin.sourceServerId,
      sourceAgentId: origin.sourceAgentId,
      sourceCwd: origin.sourceCwd,
      directory: handoffContextDirectory(reservationId, record.id),
      history: conversation.history,
      pending: record.handoffContext.pending,
      ...(conversation.historyIndex ? { historyIndex: conversation.historyIndex } : {}),
      // COMPAT(handoffContextMode): added in v0.11.1, remove after 2027-04-10 once retained v1/v2 publications finish.
      ...(bundle.version === 3 ? { continuationMode } : {}),
    };
    if (!isDeepStrictEqual(record.handoffContext, expected))
      refuse("source_changed", "Carried context differs from its original verified archive");
  }

  private async previousSegments(
    record: StoredAgentRecord,
    currentSessionId: string,
  ): Promise<{
    previous: CapturedPreviousSegment[];
    binding?: { transferId: string; manifestDigest: string };
  }> {
    if (!record.handoffContext && !this.options.destination.hasConversation(record.id))
      return { previous: [] };
    return this.options.destination.withConversationArchive(
      record.id,
      async ({ transferId, reservationId, sourceAgentId, continuationMode, archive, content }) => {
        const conversation = content.bundle.conversations.find(
          (item) => item.sourceAgentId === sourceAgentId,
        );
        const session = content.sessions.get(sourceAgentId);
        if (!conversation || !session)
          refuse("invalid_source", "Original exported conversation is missing");
        this.assertPreviousContext(
          record,
          content.bundle,
          conversation,
          reservationId,
          continuationMode,
        );
        const segments = [...(conversation.previous ?? [])];
        if (continuationMode === "context" || currentSessionId !== session.sessionId) {
          if (!conversation.history)
            refuse("invalid_source", "Earlier conversation has no readable history");
          segments.push({
            origin: handoffConversationOrigin(content.bundle, conversation),
            history: conversation.history,
            session: conversation.session,
          });
        }
        if (segments.length > HANDOFF_PREVIOUS_SEGMENTS_MAX)
          refuse("invalid_source", "Conversation exceeds the handoff history segment limit");
        return {
          binding: { transferId, manifestDigest: archive.manifest.entrypoint.sha256 },
          previous: segments.map((segment) => {
            const manifest =
              segment.session.sha256 === conversation.session.sha256
                ? session
                : content.previousSessions.get(segment.session.sha256);
            if (!manifest) refuse("invalid_source", "Earlier conversation artifacts are missing");
            return { segment, manifest, blobsDirectory: archive.blobsDirectory };
          }),
        };
      },
    );
  }

  private nativeAgent(record: StoredAgentRecord) {
    if (record.provider !== "claude" || !record.persistence)
      refuse("invalid_source", "Conversation has no saved session that can be exported");
    const runtime = readClaudeSessionRuntime(record.persistence);
    if (!runtime)
      refuse(
        "invalid_source",
        "This conversation has no recorded Claude runtime. Resume it on the source host before transferring it.",
      );
    const agent = NativeAgentSchema.parse({
      mode: "native",
      id: record.id,
      recordRevision: record.revision,
      cwd: record.cwd,
      title: record.title ?? null,
      sessionId: record.persistence.sessionId,
      projectDirName: record.persistence.metadata?.claudeProjectDirName,
      pendingRestartNote: record.pendingRestartNote,
    });
    return { ...agent, runtime };
  }
  private captureInput(
    agent: z.infer<typeof NativeAgentSchema>,
    runtime: NonNullable<PreparedSource["runtime"]>,
    artifactDirectory: string,
  ) {
    return {
      handle: {
        provider: "claude",
        sessionId: agent.sessionId,
        metadata: { claudeProjectDirName: agent.projectDirName },
      },
      cwd: agent.cwd,
      ...runtime,
      artifactDirectory,
    };
  }
  private captureDirectory(transferId: string): string {
    HandoffTransferIdSchema.parse(transferId);
    return path.join(this.options.directory, transferId);
  }
  private async readPrepared(source: SourceHandoffStatus): Promise<PreparedSource> {
    const bytes = await readBoundedFile(
      path.join(this.captureDirectory(source.id), "source.json"),
      20 * 1024 * 1024,
    );
    const prepared = PreparedSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      prepared.version === 3 &&
      prepared.agents.some((agent) => agent.recordRevision === undefined)
    )
      refuse("source_changed", "Source preparation is missing its record revision");
    if (
      prepared.transferId !== source.id ||
      prepared.cwd !== source.cwd ||
      !sameIds(
        prepared.agents.map((agent) => agent.id),
        source.agentIds,
      ) ||
      prepared.manifest.entrypoint.sha256 !== source.manifestDigest
    )
      refuse("source_changed", "Source preparation does not match its ownership journal");
    return prepared;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new HandoffSourceError("invalid_source", "Source preparation service is stopping"),
      );
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
