import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";
import type { ToolCallItem } from "@/types/stream";
import { formatAgentModelLabel, joinAgentModelLabel } from "../presentation/model-label";
import {
  resolvePaseoSubagentStatus,
  resolveProviderSubagentStatus,
  resolveSpawnCallStatus,
  type SubagentStatus,
} from "../presentation/status";
import { resolveRowLabel } from "../track-presentation";
import type { SubagentSpawnCall } from "./spawn-call";

export type SubagentOpenTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "provider_subagent"; parentAgentId: string; subagentId: string };

/** The child as the session store knows it — only the fields a row reads. */
export type SpawnedAgentSnapshot = Pick<
  Agent,
  | "id"
  | "provider"
  | "title"
  | "status"
  | "turn"
  | "createdAt"
  | "pendingPermissions"
  | "requiresAttention"
  | "attentionReason"
  | "archivedAt"
  | "model"
  | "runtimeInfo"
>;

export interface SpawnRowModel {
  key: string;
  provider: string | null;
  title: string | null;
  status: SubagentStatus;
  /** Start of the work the live timer counts; null when nothing is ticking. */
  liveSince: Date | null;
  /** How long settled work took, when the client knows it. */
  settledDurationMs: number | null;
  modelLabel: string | null;
  target: SubagentOpenTarget | null;
}

function resolvePaseoRow(
  spawn: Extract<SubagentSpawnCall, { kind: "paseo" }>,
  agent: SpawnedAgentSnapshot | null,
  providerEntries: readonly ProviderSnapshotEntry[] | undefined,
): SpawnRowModel {
  const target: SubagentOpenTarget | null = spawn.agentId
    ? { kind: "agent", agentId: spawn.agentId }
    : null;
  if (!spawn.agentId) {
    return {
      key: spawn.callId,
      provider: spawn.provider,
      title: spawn.title,
      status: resolveSpawnCallStatus(spawn.status, "paseo"),
      liveSince: null,
      settledDurationMs: null,
      modelLabel: null,
      target,
    };
  }
  const status = resolvePaseoSubagentStatus(
    agent
      ? {
          status: agent.status,
          turn: agent.turn,
          pendingPermissionCount: agent.pendingPermissions.length,
          requiresAttention: agent.requiresAttention === true,
          attentionReason: agent.attentionReason ?? null,
          isArchived: Boolean(agent.archivedAt),
        }
      : null,
  );
  let liveSince: Date | null = null;
  if (agent && status.isLive) {
    liveSince = agent.turn.phase === "open" ? (agent.turn.startedAt ?? null) : agent.createdAt;
  }
  const modelLabel = agent
    ? joinAgentModelLabel(
        formatAgentModelLabel(
          { provider: agent.provider, model: agent.runtimeInfo?.model ?? agent.model },
          providerEntries,
        ),
      )
    : null;
  return {
    key: spawn.callId,
    provider: agent?.provider ?? spawn.provider,
    title: resolveRowLabel(agent?.title) ?? spawn.title,
    status,
    liveSince,
    settledDurationMs: null,
    modelLabel,
    target,
  };
}

function resolveProviderRow(
  spawn: Extract<SubagentSpawnCall, { kind: "provider" }>,
  descriptor: ProviderSubagentDescriptorPayload | null,
): SpawnRowModel {
  if (!descriptor) {
    return {
      key: spawn.callId,
      provider: null,
      title: spawn.title,
      status: resolveSpawnCallStatus(spawn.status, "provider"),
      liveSince: null,
      settledDurationMs: null,
      modelLabel: null,
      target: null,
    };
  }
  const status = resolveProviderSubagentStatus(descriptor.status);
  const createdAt = new Date(descriptor.createdAt);
  const updatedAt = new Date(descriptor.updatedAt);
  return {
    key: spawn.callId,
    provider: descriptor.provider,
    title:
      resolveRowLabel(descriptor.description) ?? resolveRowLabel(descriptor.title) ?? spawn.title,
    status,
    liveSince: status.isLive ? createdAt : null,
    settledDurationMs: status.isLive
      ? null
      : Math.max(0, updatedAt.getTime() - createdAt.getTime()),
    modelLabel: resolveRowLabel(descriptor.subtitle),
    target: {
      kind: "provider_subagent",
      parentAgentId: descriptor.parentAgentId,
      subagentId: descriptor.id,
    },
  };
}

export interface ResolveSpawnRowInput {
  spawn: SubagentSpawnCall;
  agent: SpawnedAgentSnapshot | null;
  descriptor: ProviderSubagentDescriptorPayload | null;
  providerEntries: readonly ProviderSnapshotEntry[] | undefined;
}

export function resolveSpawnRow(input: ResolveSpawnRowInput): SpawnRowModel {
  if (input.spawn.kind === "paseo") {
    return resolvePaseoRow(input.spawn, input.agent, input.providerEntries);
  }
  return resolveProviderRow(input.spawn, input.descriptor);
}

/** When the group's timer started, while any of its children is still live. */
export function resolveSpawnGroupLiveSince(input: {
  rows: readonly SpawnRowModel[];
  calls: readonly ToolCallItem[];
}): Date | null {
  if (!input.rows.some((row) => row.status.isLive)) return null;
  const first = input.calls[0];
  return first ? first.timestamp : null;
}
