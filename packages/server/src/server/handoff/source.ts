import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import { HandoffArchiveManifestSchema, HandoffTransferIdSchema } from "@getpaseo/protocol/handoff";
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
import { packHandoffArchive, readHandoffBundle } from "./bundle.js";
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

const AgentSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().nullable(),
  sessionId: z.string().uuid(),
  projectDirName: z.string().optional(),
  pendingRestartNote: z.array(RestartCancelledWorkSchema).max(1024).optional(),
  // COMPAT(handoffCapturedRuntime): added in v0.11.1, remove after 2027-02-06 once older prepared transfers expire.
  runtime: ClaudeSessionRuntimeSchema.optional(),
});
const PreparedSchema = z.object({
  version: z.literal(1),
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
        const agent = this.nativeAgent({
          ...record,
          persistence: live?.session?.describePersistence() ?? record.persistence,
        });
        const preview = await previewClaudeSession({
          handle: {
            provider: "claude",
            sessionId: agent.sessionId,
            metadata: { claudeProjectDirName: agent.projectDirName },
          },
          cwd: agent.cwd,
          ...agent.runtime,
        });
        conversations.push({ ...identity, provider: "claude", state: "available", ...preview });
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
      const agents = records.map((record) => this.nativeAgent(record));
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
      const conversations = [];
      for (const [index, agent] of agents.entries()) {
        const artifactDirectory = path.join(directory, `conversation-${index}`);
        await captureClaudeSession(this.captureInput(agent, agent.runtime, artifactDirectory));
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
        const historyPath = path.join(directory, `history-${index}.json`);
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
        version: 1,
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
        agentId,
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
      if (
        !record ||
        !captured ||
        record.lastStatus !== "closed" ||
        record.cwd !== captured.cwd ||
        record.persistence?.sessionId !== captured.sessionId ||
        record.persistence?.metadata?.claudeProjectDirName !== captured.projectDirName
      )
        refuse("source_changed", "Source conversation changed after capture");
      if (!isDeepStrictEqual(record.pendingRestartNote ?? [], captured.pendingRestartNote ?? []))
        refuse("source_changed", "Pending restart notes changed after capture");
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
      // COMPAT(handoffCapturedRuntime): added in v0.11.1, remove after 2027-02-06 once older prepared transfers expire.
      const runtime = agent.runtime ?? prepared.runtime;
      if (!runtime) refuse("invalid_source", "Source provider configuration is missing");
      const record = records.get(agent.id);
      if (!record) refuse("source_changed", "Captured conversation is missing from the source");
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
    });
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
    const agent = AgentSchema.parse({
      id: record.id,
      cwd: record.cwd,
      title: record.title ?? null,
      sessionId: record.persistence.sessionId,
      projectDirName: record.persistence.metadata?.claudeProjectDirName,
      pendingRestartNote: record.pendingRestartNote,
    });
    return { ...agent, runtime };
  }
  private captureInput(
    agent: z.infer<typeof AgentSchema>,
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
