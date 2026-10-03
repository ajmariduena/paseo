import type { Agent } from "@/stores/session-store";

interface ShouldClearAgentAttentionInput {
  agentId: string | null | undefined;
  isConnected: boolean;
  requiresAttention: boolean | null | undefined;
  attentionReason?: "finished" | "error" | "permission" | null | undefined;
  trigger?: AgentAttentionClearTrigger;
  hasDeferredFocusEntryClear?: boolean;
}

export type AgentAttentionClearTrigger =
  | "focus-entry"
  | "input-focus"
  | "prompt-send"
  | "agent-blur";

const ATTENTION_REASON_PRIORITY = {
  permission: 0,
  error: 1,
  finished: 2,
} as const;

function getAttentionPriority(reason: Agent["attentionReason"]): number | null {
  if (!reason) {
    return null;
  }
  return ATTENTION_REASON_PRIORITY[reason];
}

export interface AgentLocation {
  serverId: string;
  agentId: string;
}

interface RankedAttentionAgent {
  agent: Agent;
  priority: number;
  timestamp: number;
}

// Pending permissions count even before the daemon flags the agent: a question
// waiting on the user is the most urgent thing there is.
function getNavigationAttentionPriority(agent: Agent): number | null {
  if (agent.parentAgentId || agent.archivedAt) {
    return null;
  }
  if (agent.pendingPermissions.length > 0) {
    return ATTENTION_REASON_PRIORITY.permission;
  }
  if (agent.requiresAttention !== true) {
    return null;
  }
  return getAttentionPriority(agent.attentionReason);
}

function compareRankedAttentionAgents(
  left: RankedAttentionAgent,
  right: RankedAttentionAgent,
): number {
  return (
    left.priority - right.priority ||
    left.timestamp - right.timestamp ||
    left.agent.serverId.localeCompare(right.agent.serverId) ||
    left.agent.id.localeCompare(right.agent.id)
  );
}

/**
 * The agent to jump to next across every host and workspace: permission or
 * question first, then error, then finished and unread, oldest first within each.
 * Repeated jumps walk that order from `current`, so the agent already on screen
 * is never the answer while another one is waiting.
 */
export function pickNextAttentionAgent(input: {
  agents: readonly Agent[];
  current: AgentLocation | null;
}): Agent | null {
  const ranked: RankedAttentionAgent[] = [];
  for (const agent of input.agents) {
    const priority = getNavigationAttentionPriority(agent);
    if (priority === null) continue;
    const timestamp = agent.attentionTimestamp?.getTime() ?? Number.POSITIVE_INFINITY;
    ranked.push({ agent, priority, timestamp });
  }
  ranked.sort(compareRankedAttentionAgents);

  const current = input.current;
  const currentIndex = current
    ? ranked.findIndex(
        ({ agent }) => agent.serverId === current.serverId && agent.id === current.agentId,
      )
    : -1;
  if (currentIndex === -1) {
    return ranked[0]?.agent ?? null;
  }
  if (ranked.length === 1) {
    return null;
  }
  return ranked[(currentIndex + 1) % ranked.length].agent;
}

export function pickAttentionAgent(agents: Agent[]): string | null {
  let selectedAgentId: string | null = null;
  let selectedPriority = Number.POSITIVE_INFINITY;
  let selectedTimestamp = Number.POSITIVE_INFINITY;

  for (const agent of agents) {
    if (agent.requiresAttention !== true) {
      continue;
    }

    if (agent.parentAgentId) {
      continue;
    }

    const priority = getAttentionPriority(agent.attentionReason);
    if (priority === null) {
      continue;
    }

    const timestamp = agent.attentionTimestamp?.getTime() ?? Number.POSITIVE_INFINITY;
    const isHigherPriority = priority < selectedPriority;
    const isOlderAtSamePriority = priority === selectedPriority && timestamp < selectedTimestamp;
    if (isHigherPriority || isOlderAtSamePriority) {
      selectedAgentId = agent.id;
      selectedPriority = priority;
      selectedTimestamp = timestamp;
    }
  }

  return selectedAgentId;
}

export function shouldClearAgentAttention(input: ShouldClearAgentAttentionInput): boolean {
  const agentId = input.agentId?.trim();
  if (!agentId) {
    return false;
  }
  if (!input.isConnected) {
    return false;
  }
  if (!input.requiresAttention) {
    return false;
  }
  if (input.attentionReason === "permission") {
    return false;
  }
  if (input.trigger === "focus-entry" && input.hasDeferredFocusEntryClear === true) {
    return false;
  }
  return true;
}
