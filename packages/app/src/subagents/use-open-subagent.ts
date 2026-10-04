import { useCallback } from "react";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { useSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";

export interface OpenSubagentActions {
  openSubagent: (agentId: string) => void;
  openProviderSubagent: (parentAgentId: string, subagentId: string) => void;
}

/**
 * Opens a subagent the way the subagents track does, honoring the "Open location → Subagents"
 * desktop preference. Compact layouts always open the tab.
 */
export function useOpenSubagent(input: {
  serverId: string;
  workspaceId: string | undefined;
}): OpenSubagentActions {
  const { serverId, workspaceId } = input;
  const { tabId, openTab } = usePaneContext();
  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;

  const openSubagent = useCallback(
    (agentId: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      if (agent?.workspaceId && agent.workspaceId !== workspaceId) {
        navigateToAgent({ serverId, agentId });
        return;
      }
      if (canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "agent", agentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId: tabId,
        });
        return;
      }
      navigateToAgent({ serverId, agentId });
    },
    [canSplit, isCompact, openInSidePane, serverId, tabId, workspaceId, workspaceKey],
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
          parentTabId: tabId,
        });
        return;
      }
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [canSplit, isCompact, openInSidePane, openTab, tabId, workspaceKey],
  );

  return { openSubagent, openProviderSubagent };
}
