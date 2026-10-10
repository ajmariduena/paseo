import path from "node:path";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type FileBackedProjectRegistry,
  type FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { parseStoredAgentRecord, type AgentStorage } from "../agent/agent-storage.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { DestinationHandoffStatus } from "./destination.js";
import { handoffConversationOrigin, type HandoffBundle } from "./bundle.js";
import type { WorkspaceManifest } from "./workspace.js";
import { handoffContextDirectory } from "./context.js";
import { remapHandoffQueueEntry, type HandoffQueue } from "../agent-queue/store.js";
import type { AgentQueueRunner } from "../agent-queue/runner.js";

export interface HandoffPublicationInput {
  record: DestinationHandoffStatus;
  bundle: HandoffBundle;
  workspace: WorkspaceManifest;
  queues: ReadonlyMap<string, HandoffQueue>;
}
export interface HandoffPublication {
  install(input: HandoffPublicationInput): Promise<void>;
  publish(record: DestinationHandoffStatus): Promise<void>;
}
interface PublicationStores {
  projects: FileBackedProjectRegistry;
  workspaces: FileBackedWorkspaceRegistry;
  agents: AgentStorage;
  agentManager: Pick<AgentManager, "publishStoredAgent">;
  queues: Pick<AgentQueueRunner, "installHandoffQueue">;
}

/** Registry reads remain gated by the destination journal until every write is durable. */
export function createHandoffPublication(stores: PublicationStores): HandoffPublication {
  return {
    async install({ record, workspace, bundle, queues }) {
      if (!record.activationAt) throw new Error("Handoff activation timestamp is missing");
      const timestamp = record.activationAt;
      const displayName =
        path.basename(bundle.sourceCwd.replace(/\\/g, "/")) || "Transferred workspace";
      await stores.projects.installHandoffRecord(
        createPersistedProjectRecord({
          projectId: record.projectId,
          rootPath: record.destinationCwd,
          kind: workspace.git ? "git" : "non_git",
          displayName,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      await stores.workspaces.installHandoffRecord(
        createPersistedWorkspaceRecord({
          workspaceId: record.workspaceId,
          projectId: record.projectId,
          cwd: record.destinationCwd,
          kind: workspace.git ? "local_checkout" : "directory",
          displayName,
          worktreeRoot: workspace.git ? record.destinationCwd : null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      for (const mapping of record.agentMappings) {
        const conversation = record.preparedConversations.find(
          (item) => item.sourceAgentId === mapping.sourceAgentId,
        );
        if (!conversation) throw new Error("Handoff conversation is not prepared");
        const exported = bundle.conversations.find(
          (item) => item.sourceAgentId === mapping.sourceAgentId,
        );
        if (!exported) throw new Error("Captured conversation is missing");
        const handoffContext = publishedContext(
          record,
          bundle,
          exported,
          mapping.destinationAgentId,
          conversation.mode,
        );
        await stores.agents.installHandoffRecord(
          parseStoredAgentRecord({
            id: mapping.destinationAgentId,
            provider: "claude",
            cwd: record.destinationCwd,
            workspaceId: record.workspaceId,
            title: conversation.title,
            createdAt: timestamp,
            updatedAt: timestamp,
            labels: { "paseo.handoff-mode": conversation.mode },
            lastStatus: "closed",
            archivedAt: null,
            config: {},
            ...(handoffContext ? { handoffContext } : {}),
            ...(exported.pendingRestartNote
              ? { pendingRestartNote: exported.pendingRestartNote }
              : {}),
            persistence:
              conversation.mode === "native"
                ? {
                    provider: "claude",
                    sessionId: conversation.sessionId,
                    nativeHandle: conversation.sessionId,
                    metadata: {
                      cwd: record.destinationCwd,
                      claudeProjectDirName: `paseo-handoff-${mapping.destinationAgentId}`,
                      ...(conversation.runtime ? { claudeRuntime: conversation.runtime } : {}),
                    },
                  }
                : null,
          }),
        );
        const queue = queues.get(mapping.sourceAgentId);
        if (queue) {
          const remapped = {
            ...queue,
            entries: queue.entries.map((entry) => {
              if (!entry.senderAgentId) return entry;
              const sender = record.agentMappings.find(
                (item) => item.sourceAgentId === entry.senderAgentId,
              );
              if (!sender) throw new Error("Queued sender is outside the handoff");
              return remapHandoffQueueEntry(entry, sender.destinationAgentId);
            }),
          };
          await stores.queues.installHandoffQueue(
            mapping.destinationAgentId,
            record.reservationId,
            remapped,
          );
        }
      }
    },
    async publish(record) {
      await stores.projects.publishHandoffRecord(record.projectId);
      await stores.workspaces.publishHandoffRecord(record.workspaceId);
      for (const mapping of record.agentMappings)
        await stores.agentManager.publishStoredAgent(mapping.destinationAgentId);
    },
  };
}

function publishedContext(
  record: DestinationHandoffStatus,
  bundle: HandoffBundle,
  exported: HandoffBundle["conversations"][number],
  destinationAgentId: string,
  mode: "native" | "context",
) {
  if (mode !== "context" && !exported.previous?.length) return undefined;
  if (!exported.history) throw new Error("Captured history is missing");
  const origin = handoffConversationOrigin(bundle, exported);
  return {
    sourceServerId: origin.sourceServerId,
    sourceAgentId: origin.sourceAgentId,
    sourceCwd: origin.sourceCwd,
    directory: handoffContextDirectory(record.reservationId, destinationAgentId),
    history: exported.history,
    ...(exported.historyIndex ? { historyIndex: exported.historyIndex } : {}),
    // COMPAT(handoffContextMode): added in v0.11.1, remove after 2027-04-10 once retained v1/v2 publications finish.
    ...(bundle.version >= 3 ? { continuationMode: mode } : {}),
    pending: true,
  };
}
