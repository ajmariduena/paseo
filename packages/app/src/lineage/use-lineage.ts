import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { useFetchQuery } from "@/data/query";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import {
  formatAgentModelLabel,
  joinAgentModelLabel,
  resolveAgentModelLabelInput,
} from "@/subagents/presentation/model-label";
import { resolvePaseoSubagentStatus } from "@/subagents/presentation/status";
import { useSubagentsForParent } from "@/subagents/select";
import { resolveRowLabel } from "@/subagents/track-presentation";
import {
  buildLineageSections,
  type ArchivedLineageAgent,
  type LineageParent,
  type LineageSections,
} from "./model";

const ARCHIVED_STALE_TIME_MS = 30_000;

export type ArchivedLineageState =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "failed"; retry: () => void }
  | { kind: "loaded" };

export interface Lineage {
  sections: LineageSections;
  archived: ArchivedLineageState;
}

function useLineageParent(serverId: string, agentId: string): LineageParent | null {
  const { entries } = useProvidersSnapshot(serverId);
  const parent = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      const parentId = agent?.parentAgentId;
      if (!parentId) return null;
      const found = session?.agents.get(parentId) ?? session?.agentDetails.get(parentId);
      return { id: parentId, agent: found ?? null };
    }),
  );
  return useMemo(() => {
    if (!parent) return null;
    const { agent } = parent;
    if (!agent) {
      return {
        id: parent.id,
        title: null,
        provider: "",
        status: resolvePaseoSubagentStatus(null),
        modelLabel: null,
      };
    }
    return {
      id: parent.id,
      title: resolveRowLabel(agent.title),
      provider: agent.provider,
      status: resolvePaseoSubagentStatus({
        status: agent.status,
        turn: agent.turn,
        pendingPermissionCount: agent.pendingPermissions.length,
        requiresAttention: agent.requiresAttention === true,
        attentionReason: agent.attentionReason ?? null,
        lastTurnOutcome: agent.parentAgentId ? (agent.lastTurnOutcome ?? null) : null,
        isArchived: Boolean(agent.archivedAt),
      }),
      modelLabel: joinAgentModelLabel(
        formatAgentModelLabel(resolveAgentModelLabelInput(agent), entries),
      ),
    };
  }, [entries, parent]);
}

/** Parent, subagents and — once asked for — archived subagents of one agent session. */
export function useLineage(input: {
  serverId: string;
  agentId: string;
  includeArchived: boolean;
}): Lineage {
  const { serverId, agentId, includeArchived } = input;
  const parent = useLineageParent(serverId, agentId);
  const children = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const archivedQuery = useFetchQuery({
    queryKey: ["lineage", "archived-subagents", serverId, agentId],
    enabled: includeArchived && client !== null,
    queryFn: async (): Promise<ArchivedLineageAgent[]> => {
      if (!client) throw new Error("Host is offline");
      const payload = await client.fetchAgents({
        filter: { labels: { [PARENT_AGENT_ID_LABEL]: agentId }, includeArchived: true },
      });
      return payload.entries.map((entry) => entry.agent);
    },
    dataShape: "list",
    staleTimeMs: ARCHIVED_STALE_TIME_MS,
  });
  const archivedAgents = includeArchived ? (archivedQuery.data ?? null) : null;
  const sections = useMemo(
    () => buildLineageSections({ parent, children, archived: archivedAgents }),
    [archivedAgents, children, parent],
  );
  const { refetch } = archivedQuery;
  const archived = useMemo<ArchivedLineageState>(() => {
    if (!includeArchived) return { kind: "off" };
    if (archivedQuery.isError) return { kind: "failed", retry: () => void refetch() };
    if (archivedQuery.data) return { kind: "loaded" };
    return { kind: "loading" };
  }, [archivedQuery.data, archivedQuery.isError, includeArchived, refetch]);
  return { sections, archived };
}
