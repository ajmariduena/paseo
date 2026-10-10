import { useMemo } from "react";
import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeSnapshot,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { POLL_INTERVAL_MS } from "./model";

export const hostMetricsQueryBaseKey = ["host-metrics"] as const;

export type HostMetricsState =
  | { kind: "unsupported" }
  | { kind: "waiting"; status: HostRuntimeConnectionStatus }
  | {
      kind: "metrics";
      metrics: HostMetricsSnapshot;
      receivedAt: number;
      // False while the host is offline: the metrics are the last ones it sent.
      live: boolean;
    }
  | { kind: "error"; message: string };

export function useHostMetrics(serverId: string): HostMetricsState {
  const connectionStatus = useHostRuntimeSnapshot(serverId)?.connectionStatus ?? "connecting";
  const supported = useHostFeature(serverId, "hostMetrics");
  const online = connectionStatus === "online";

  const query = useFetchQuery({
    queryKey: [...hostMetricsQueryBaseKey, serverId],
    queryFn: async () => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("Host is offline");
      const payload = await client.getHostMetrics();
      return payload.metrics;
    },
    enabled: online && supported,
    dataShape: "value",
    staleTimeMs: 0,
    refetchInterval: POLL_INTERVAL_MS,
    // The sampler runs only while asked, so keep asking only while the screen is visible.
    refetchIntervalInBackground: false,
    retry: false,
  });

  if (query.data) {
    return {
      kind: "metrics",
      metrics: query.data,
      receivedAt: query.dataUpdatedAt,
      live: online && supported,
    };
  }
  if (online && !supported) return { kind: "unsupported" };
  if (query.error && online) return { kind: "error", message: query.error.message };
  return { kind: "waiting", status: connectionStatus };
}

export interface ProcessAgent {
  agentId: string;
  title: string;
  projectName: string | null;
  workspaceId: string | null;
}

export interface HostAgents {
  byKey: ReadonlyMap<string, ProcessAgent>;
  runningByServer: ReadonlyMap<string, number>;
}

/** Agents of every host, for labelling the processes they spawned and counting what runs where. */
export function useHostAgents(): HostAgents {
  const { agents } = useAggregatedAgents({ includeArchived: true });
  return useMemo(() => {
    const byKey = new Map<string, ProcessAgent>();
    const runningByServer = new Map<string, number>();
    for (const agent of agents) {
      byKey.set(processAgentKey(agent.serverId, agent.id), {
        agentId: agent.id,
        title: agent.title ?? agent.id.slice(0, 8),
        projectName: agent.projectPlacement?.projectName ?? null,
        workspaceId: agent.workspaceId ?? null,
      });
      if (agent.status === "running" && !agent.archivedAt) {
        runningByServer.set(agent.serverId, (runningByServer.get(agent.serverId) ?? 0) + 1);
      }
    }
    return { byKey, runningByServer };
  }, [agents]);
}

export function processAgentKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}
