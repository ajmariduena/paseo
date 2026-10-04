import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MenuSeparator, MenuSubTrigger, type MenuPageDefinition } from "@/components/ui/menu";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { useOpenSubagent } from "@/subagents/use-open-subagent";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";
import { LineageMenuContent } from "./sheet";

const LINEAGE_PAGE_ID = "lineage";

interface AgentTabLineageInput {
  serverId: string;
  workspaceId: string;
  tabId: string;
  agentId: string;
}

function AgentTabLineagePage({
  serverId,
  workspaceId,
  tabId,
  agentId,
}: AgentTabLineageInput): ReactElement {
  const openTab = useCallback(
    (target: WorkspaceTabTarget) => {
      openWorkspaceTargetAtLocation({
        isCompact: false,
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        target,
        location: "main",
        parentTabId: tabId,
      });
    },
    [serverId, tabId, workspaceId],
  );
  const actions = useOpenSubagent({ serverId, workspaceId, parentTabId: tabId, openTab });
  return <LineageMenuContent serverId={serverId} agentId={agentId} actions={actions} />;
}

/** The Lineage page of an agent tab's context menu; none for other tabs. */
export function useAgentTabLineagePages(input: {
  serverId: string;
  workspaceId: string;
  tabId: string;
  agentId: string | null;
}): readonly MenuPageDefinition[] | undefined {
  const { t } = useTranslation();
  const { serverId, workspaceId, tabId, agentId } = input;
  return useMemo(
    () =>
      agentId
        ? [
            {
              id: LINEAGE_PAGE_ID,
              title: t("lineage.title"),
              content: (
                <AgentTabLineagePage
                  serverId={serverId}
                  workspaceId={workspaceId}
                  tabId={tabId}
                  agentId={agentId}
                />
              ),
            },
          ]
        : undefined,
    [agentId, serverId, t, tabId, workspaceId],
  );
}

/**
 * The row leading to that page, shown only when the agent has a parent or subagents. It mounts
 * with the open menu, so its scan of the session's agents runs only while the menu is up.
 */
export function AgentTabLineageTrigger({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const hasAgentRelation = useSessionStore((state) => {
    const agents = state.sessions[serverId]?.agents;
    if (!agents) return false;
    if (agents.get(agentId)?.parentAgentId) return true;
    for (const agent of agents.values()) {
      if (agent.parentAgentId === agentId) return true;
    }
    return false;
  });
  const hasProviderSubagents = useProviderSubagentStore((state) => {
    const prefix = `${serverId}\0${agentId}\0`;
    for (const key of state.descriptors.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  });
  if (!hasAgentRelation && !hasProviderSubagents) return null;
  return (
    <>
      <MenuSubTrigger id={LINEAGE_PAGE_ID} testID="workspace-tab-menu-lineage">
        {t("lineage.title")}
      </MenuSubTrigger>
      <MenuSeparator />
    </>
  );
}
