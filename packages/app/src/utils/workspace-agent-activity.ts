import type { AgentBackgroundTask } from "@getpaseo/protocol/agent-types";
import type { Agent } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: SidebarStateBucket;
  enteredAt: Date | null;
  /** Live background tasks across every root agent in the workspace, not just the latest one. */
  backgroundTasks: readonly AgentBackgroundTask[];
}

const NO_BACKGROUND_TASKS: readonly AgentBackgroundTask[] = [];

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const backgroundTasksByWorkspaceId = new Map<string, AgentBackgroundTask[]>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }
    collectBackgroundTasks(backgroundTasksByWorkspaceId, agent.workspaceId, agent);

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivity = activityByWorkspaceId.get(agent.workspaceId);
    if (latestActivity?.enteredAt && enteredAt <= latestActivity.enteredAt) {
      continue;
    }
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status: workspaceAgentBucket(agent),
      enteredAt,
      backgroundTasks: NO_BACKGROUND_TASKS,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    const backgroundTasks = backgroundTasksByWorkspaceId.get(workspaceId) ?? NO_BACKGROUND_TASKS;
    const status =
      activity.status === "done" && backgroundTasks.length > 0 ? "background" : activity.status;
    const next = { ...activity, status, backgroundTasks };
    const previousActivity = previous?.get(workspaceId);
    activityByWorkspaceId.set(
      workspaceId,
      previousActivity && isSameActivity(previousActivity, next) ? previousActivity : next,
    );
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function workspaceAgentBucket(agent: Agent): SidebarStateBucket {
  return deriveSidebarStateBucket({
    status: workspaceAgentStatus(agent),
    pendingPermissionCount: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  });
}

function collectBackgroundTasks(
  backgroundTasksByWorkspaceId: Map<string, AgentBackgroundTask[]>,
  workspaceId: string,
  agent: Agent,
): void {
  if (!agent.backgroundTasks?.length) return;
  const tasks = backgroundTasksByWorkspaceId.get(workspaceId) ?? [];
  tasks.push(...agent.backgroundTasks);
  backgroundTasksByWorkspaceId.set(workspaceId, tasks);
}

function isSameActivity(previous: WorkspaceAgentActivity, next: WorkspaceAgentActivity): boolean {
  return (
    previous.agentId === next.agentId &&
    previous.status === next.status &&
    areBackgroundTasksIdentical(previous.backgroundTasks, next.backgroundTasks)
  );
}

function areBackgroundTasksIdentical(
  previous: readonly AgentBackgroundTask[],
  next: readonly AgentBackgroundTask[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every(
    (task, index) => task.id === next[index]?.id && task.description === next[index]?.description,
  );
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
