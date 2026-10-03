import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-api-context";
import type { AgentNavigation } from "@/keyboard/route-shortcut";
import { getFocusedAgentId } from "@/plugins/command-center/context";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { pickNextAttentionAgent } from "@/utils/agent-attention";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { createAgentHistory, type AgentVisit } from "./agent-history";

const agentHistory = createAgentHistory({
  now: () => Date.now(),
  capacity: 50,
  cycleWindowMs: 1500,
});

let focusedAgent: AgentVisit | null = null;

function isVisitAvailable(visit: AgentVisit): boolean {
  const agent = useSessionStore.getState().sessions[visit.serverId]?.agents.get(visit.agentId);
  return agent !== undefined && !agent.archivedAt;
}

function openAgent(visit: { serverId: string; agentId: string }) {
  navigateToAgent({ serverId: visit.serverId, agentId: visit.agentId });
}

/** Feeds the in-memory history with every agent the user lands on, on any host. */
export function useAgentVisitTracking() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const workspaceKey =
    serverId && workspaceId ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId }) : null;
  const agentId = useWorkspaceLayoutStore((state) =>
    workspaceKey ? getFocusedAgentId(state.layoutByWorkspace[workspaceKey] ?? null) : null,
  );

  useEffect(() => {
    if (!serverId || !workspaceId || !agentId) {
      focusedAgent = null;
      return;
    }
    focusedAgent = { serverId, workspaceId, agentId };
    agentHistory.visit(focusedAgent);
  }, [agentId, serverId, workspaceId]);
}

function navigateToRecentAgent(delta: 1 | -1) {
  const target = agentHistory.cycleRecent(delta, isVisitAvailable);
  if (target) openAgent(target);
}

function navigateAgentHistory(delta: 1 | -1) {
  const target = agentHistory.step(delta, isVisitAvailable);
  if (target) openAgent(target);
}

function navigateToNextAttentionAgent(): boolean {
  const agents = Object.values(useSessionStore.getState().sessions).flatMap((session) =>
    Array.from(session.agents.values()),
  );
  const next = pickNextAttentionAgent({ agents, current: focusedAgent });
  if (!next) return false;
  openAgent({ serverId: next.serverId, agentId: next.id });
  return true;
}

export function useAgentNavigation(): (navigation: AgentNavigation) => void {
  const toast = useToast();
  const { t } = useTranslation();
  return useCallback(
    (navigation: AgentNavigation) => {
      switch (navigation.type) {
        case "next-attention":
          if (!navigateToNextAttentionAgent()) {
            toast.show(t("shell.nothingNeedsAttention"));
          }
          return;
        case "recent":
          navigateToRecentAgent(navigation.delta);
          return;
        case "history":
          navigateAgentHistory(navigation.delta);
          return;
      }
    },
    [t, toast],
  );
}
