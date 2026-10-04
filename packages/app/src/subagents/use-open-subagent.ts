import { useCallback } from "react";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  openPreferredWorkspaceTarget,
  openWorkspaceTargetAtLocation,
} from "@/workspace-tabs/open-beside";

export interface OpenSubagentActions {
  openSubagent: (agentId: string) => void;
  openProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  /** Opens the agent that started this one, in the main pane. */
  openParent: (agentId: string) => void;
}

/**
 * Opens a related agent the way the subagents track does: children honor the "Open location →
 * Subagents" desktop preference, an agent in another workspace navigates there, and compact
 * layouts always open the tab.
 */
export function useOpenSubagent(input: {
  serverId: string;
  workspaceId: string | undefined;
  /** The tab the request comes from; children open in its pane. */
  parentTabId: string | null;
  /** Opens a provider subagent tab when the layout cannot split. */
  openTab: (target: WorkspaceTabTarget) => void;
}): OpenSubagentActions {
  const { serverId, workspaceId, parentTabId, openTab } = input;
  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;

  const isInOtherWorkspace = useCallback(
    (agentId: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return Boolean(agent?.workspaceId && agent.workspaceId !== workspaceId);
    },
    [serverId, workspaceId],
  );

  const openSubagent = useCallback(
    (agentId: string) => {
      if (!isInOtherWorkspace(agentId) && canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "agent", agentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId,
        });
        return;
      }
      navigateToAgent({ serverId, agentId });
    },
    [canSplit, isCompact, isInOtherWorkspace, openInSidePane, parentTabId, serverId, workspaceKey],
  );

  const openProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      if (canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "provider_subagent", parentAgentId, subagentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId,
        });
        return;
      }
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [canSplit, isCompact, openInSidePane, openTab, parentTabId, workspaceKey],
  );

  const openParent = useCallback(
    (agentId: string) => {
      if (!isInOtherWorkspace(agentId) && canSplit && workspaceKey) {
        openWorkspaceTargetAtLocation({
          isCompact,
          workspaceKey,
          target: { kind: "agent", agentId },
          location: "main",
          parentTabId,
        });
        return;
      }
      navigateToAgent({ serverId, agentId });
    },
    [canSplit, isCompact, isInOtherWorkspace, parentTabId, serverId, workspaceKey],
  );

  return { openSubagent, openProviderSubagent, openParent };
}
