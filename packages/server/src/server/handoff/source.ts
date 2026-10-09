import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { HandoffArchiveManifestSchema, HandoffTransferIdSchema } from "@getpaseo/protocol/handoff";
import type {
  HandoffConversationPreview,
  HandoffSourcePreview,
} from "@getpaseo/protocol/handoff-control";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createProviderEnv } from "../agent/provider-launch-config.js";
import { resolveClaudeCodeVersion } from "../agent/providers/claude/agent.js";
import { claudeConfigDir } from "../agent/providers/claude/project-dir.js";
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
import { captureWorkspace, verifyCapturedWorkspace, previewWorkspace } from "./workspace.js";
import { packHandoffArchive, readHandoffBundle } from "./bundle.js";
import { writeHandoffHistory, readHandoffHistory, fetchHandoffHistory } from "./history.js";
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
    "getAgent" | "listAgents" | "closeAgent" | "projectHistoryForHandoff"
  >;
  terminals: Pick<TerminalManager, "listDirectories" | "getTerminals" | "killTerminalAndWait">;
  setup: Pick<WorkspaceSetupRuntime, "stop" | "countActive">;
  getProviderRuntimeSettings: ProviderSnapshotManager["getProviderRuntimeSettings"];
}
interface SourceRequest {
  transferId: string;
  workspaceId: string;
  agentIds: string[];
  destinationServerId: string;
  reservationId: string;
}

export class HandoffSourceError extends Error {
  constructor(
    readonly code: "invalid_source" | "inventory_changed" | "stop_uncertain" | "source_changed",
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
    let runtime: ReturnType<HandoffSource["nativeRuntime"]> | undefined;
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
        const agent = this.nativeAgent(record);
        runtime ??= this.nativeRuntime();
        const preview = await previewClaudeSession({
          handle: {
            provider: "claude",
            sessionId: agent.sessionId,
            metadata: { claudeProjectDirName: agent.projectDirName },
          },
          cwd: agent.cwd,
          ...(await runtime),
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
    return {
      workspaceId,
      cwd: inventory.cwd,
      conversations,
      workspace,
      stoppedWork: {
        agentIds: inventory.agentIds.filter((id) => this.options.agentManager.getAgent(id)),
        terminals: terminals.map((terminal) => ({ id: terminal.id, name: terminal.name })),
        setupOperations: this.options.setup.countActive(workspaceId),
      },
    };
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
      let source = await this.options.ownership.prepare({
        id: input.transferId,
        ...inventory,
        destinationServerId: input.destinationServerId,
        reservationId: input.reservationId,
      });
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
      for (const id of source.agentIds)
        records.push(await this.options.agents.checkpointClosedAgent(id));
      const agents = records.map((record) => this.nativeAgent(record));
      const runtime = agents.length > 0 ? await this.nativeRuntime() : null;
      const directory = this.captureDirectory(source.id);
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { mode: 0o700 });
      await syncDirectory(this.options.directory);
      const workspaceDirectory = path.join(directory, "workspace");
      await captureWorkspace({ cwd: source.cwd, artifactDirectory: workspaceDirectory });
      const conversations = [];
      for (const [index, agent] of agents.entries()) {
        if (!runtime) refuse("invalid_source", "Source provider configuration is missing");
        const artifactDirectory = path.join(directory, `conversation-${index}`);
        await captureClaudeSession(this.captureInput(agent, runtime, artifactDirectory));
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
          rows,
        });
        conversations.push({
          sourceAgentId: agent.id,
          title: agent.title,
          artifactDirectory,
          historyPath,
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
        runtime,
        manifest,
      };
      await writeJournal(path.join(directory, "source.json"), prepared);
      await this.verify(source, prepared);
      source = await this.options.ownership.markReady(source.id, manifest.entrypoint.sha256);
      return { source, manifest };
    });
  }

  async status(transferId: string) {
    const source = this.options.ownership.status(transferId);
    const captured = source.state === "ready" || source.state === "released";
    const manifest = captured ? (await this.readPrepared(source)).manifest : null;
    return { source, manifest };
  }

  findWorkspace(workspaceId: string) {
    // Discovery must still work after the source checkout has been removed.
    return this.options.ownership.forWorkspace(workspaceId);
  }

  cancel(input: HandoffCancellationInput) {
    // Do not reopen source admission while its preparation is still stopping or capturing writers.
    return this.serialize(() => this.options.ownership.cancelReservation(input));
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
    });
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
    const stops = [() => this.options.setup.stop(source.workspaceId)];
    for (const id of source.agentIds) stops.push(() => this.options.agentManager.closeAgent(id));
    for (const terminal of await this.sourceTerminals(source))
      stops.push(() => this.options.terminals.killTerminalAndWait(terminal.id));
    const results = await Promise.allSettled(stops.map(async (stop) => stop()));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Source writers did not all stop; handoff remains fenced",
      );
  }

  private async verify(source: SourceHandoffStatus, prepared: PreparedSource): Promise<void> {
    const inventory = await this.inspect(source.workspaceId);
    if (!sameIds(inventory.agentIds, source.agentIds))
      refuse("inventory_changed", "Source conversation inventory changed after capture");
    for (const id of source.agentIds) {
      if (this.options.agentManager.getAgent(id))
        refuse("stop_uncertain", "Source provider runtime is still loaded");
      const record = await this.options.agents.get(id);
      const captured = prepared.agents.find((agent) => agent.id === id);
      if (
        !record ||
        record.lastStatus !== "closed" ||
        record.persistence?.sessionId !== captured?.sessionId
      )
        refuse("source_changed", "Source conversation changed after capture");
    }
    const directory = this.captureDirectory(source.id);
    await verifyCapturedWorkspace({
      cwd: source.cwd,
      artifactDirectory: path.join(directory, "workspace"),
    });
    for (const [index, agent] of prepared.agents.entries()) {
      if (!prepared.runtime) refuse("invalid_source", "Source provider configuration is missing");
      await verifyCapturedClaudeSession(
        this.captureInput(agent, prepared.runtime, path.join(directory, `conversation-${index}`)),
      );
    }
    await this.options.archives.withVerifiedArchive(source.id, async (archive) => {
      if (archive.manifest.entrypoint.sha256 !== prepared.manifest.entrypoint.sha256)
        refuse("source_changed", "Source archive changed after capture");
    });
  }

  private nativeAgent(record: StoredAgentRecord): z.infer<typeof AgentSchema> {
    if (record.provider !== "claude" || !record.persistence)
      refuse("invalid_source", "Conversation has no saved session that can be exported");
    return AgentSchema.parse({
      id: record.id,
      cwd: record.cwd,
      title: record.title ?? null,
      sessionId: record.persistence.sessionId,
      projectDirName: record.persistence.metadata?.claudeProjectDirName,
    });
  }
  private async nativeRuntime() {
    const settings = this.options.getProviderRuntimeSettings("claude");
    return {
      configDir: path.resolve(claudeConfigDir(createProviderEnv({ runtimeSettings: settings }))),
      cliVersion: await resolveClaudeCodeVersion(settings),
    };
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
