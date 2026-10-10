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
import type { HandoffBundle } from "./bundle.js";
import type { WorkspaceManifest } from "./workspace.js";
import { handoffContextDirectory } from "./context.js";

export interface HandoffPublicationInput {
  record: DestinationHandoffStatus;
  bundle: HandoffBundle;
  workspace: WorkspaceManifest;
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
}

/** Registry reads remain gated by the destination journal until every write is durable. */
export function createHandoffPublication(stores: PublicationStores): HandoffPublication {
  return {
    async install({ record, workspace, bundle }) {
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
        if (conversation.mode === "context" && !exported.history)
          throw new Error("Captured history is missing");
        const handoffContext =
          conversation.mode === "context"
            ? {
                sourceServerId: record.sourceServerId,
                sourceAgentId: mapping.sourceAgentId,
                sourceCwd: bundle.sourceCwd,
                directory: handoffContextDirectory(
                  record.reservationId,
                  mapping.destinationAgentId,
                ),
                history: exported.history,
                pending: true,
              }
            : undefined;
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
