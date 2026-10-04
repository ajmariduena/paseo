import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import invariant from "tiny-invariant";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { usePaneContext } from "@/panels/pane-context";
import { useProviderSubagentStore } from "../provider-store";
import { useOpenSubagent } from "../use-open-subagent";
import type { SubagentOpenTarget } from "./model";

interface SubagentTimelineContextValue {
  serverId: string;
  providerSubagentsByCallId: ReadonlyMap<string, ProviderSubagentDescriptorPayload>;
  providerEntries: readonly ProviderSnapshotEntry[] | undefined;
  open: (target: SubagentOpenTarget) => void;
  /** Groups the user opened or closed; the rest follow their default. */
  groupExpansion: ReadonlyMap<string, boolean>;
  setGroupExpanded: (groupId: string, expanded: boolean) => void;
}

const SubagentTimelineContext = createContext<SubagentTimelineContextValue | null>(null);

export function useSubagentTimeline(): SubagentTimelineContextValue {
  const value = useContext(SubagentTimelineContext);
  invariant(value, "SubagentTimelineProvider is required");
  return value;
}

/**
 * What subagent rows in one transcript share: the provider subagents indexed by the tool call
 * that started them, model labels, how to open a child, and which groups are open. Context rather
 * than props so a memoized history row picks up a child's change without the stream re-rendering.
 */
export function SubagentTimelineProvider({
  serverId,
  workspaceId,
  streamAgentId,
  subagentParentId,
  children,
}: {
  serverId: string;
  workspaceId: string | undefined;
  streamAgentId: string;
  /** Set when the stream is not a managed agent's own, as in a provider subagent pane. */
  subagentParentId: string | undefined;
  children: ReactNode;
}) {
  const parentAgentId = subagentParentId ?? streamAgentId;
  const descriptors = useProviderSubagentStore((state) => state.descriptors);
  const providerEntries = useProvidersSnapshot(serverId).entries;
  const { tabId, openTab } = usePaneContext();
  const { openSubagent, openProviderSubagent } = useOpenSubagent({
    serverId,
    workspaceId,
    parentTabId: tabId,
    openTab,
  });
  const [groupExpansion, setGroupExpansion] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

  const providerSubagentsByCallId = useMemo(() => {
    const prefix = `${serverId}\0${parentAgentId}\0`;
    const index = new Map<string, ProviderSubagentDescriptorPayload>();
    for (const [key, descriptor] of descriptors) {
      if (key.startsWith(prefix) && descriptor.toolCallId) {
        index.set(descriptor.toolCallId, descriptor);
      }
    }
    return index;
  }, [descriptors, parentAgentId, serverId]);

  const open = useCallback(
    (target: SubagentOpenTarget) => {
      if (target.kind === "agent") {
        openSubagent(target.agentId);
      } else {
        openProviderSubagent(target.parentAgentId, target.subagentId);
      }
    },
    [openProviderSubagent, openSubagent],
  );

  const setGroupExpanded = useCallback((groupId: string, expanded: boolean) => {
    setGroupExpansion((previous) => new Map(previous).set(groupId, expanded));
  }, []);

  const value = useMemo<SubagentTimelineContextValue>(
    () => ({
      serverId,
      providerSubagentsByCallId,
      providerEntries,
      open,
      groupExpansion,
      setGroupExpanded,
    }),
    [groupExpansion, open, providerEntries, providerSubagentsByCallId, serverId, setGroupExpanded],
  );

  return (
    <SubagentTimelineContext.Provider value={value}>{children}</SubagentTimelineContext.Provider>
  );
}
