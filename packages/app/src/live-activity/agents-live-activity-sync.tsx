import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { AgentsLiveActivity } from "./controller";
import { liveActivityNative } from "./native";
import type { LiveActivityLabels } from "./summary";

function useLabels(): () => LiveActivityLabels {
  const { t } = useTranslation();
  const latest = useRef(t);
  latest.current = t;
  return useRef(() => {
    const translate = latest.current;
    return {
      headline: ({ working, waiting, finished }) =>
        [
          working > 0 ? translate("liveActivity.working", { count: working }) : null,
          waiting > 0 ? translate("liveActivity.waiting", { count: waiting }) : null,
          finished > 0 ? translate("liveActivity.finished", { count: finished }) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      working: () => translate("liveActivity.workingShort"),
      waiting: (count) => translate("liveActivity.waitingShort", { count }),
      permission: translate("liveActivity.permission"),
      finished: translate("liveActivity.doneLabel"),
      failed: translate("liveActivity.failed"),
      untitled: translate("agentList.fallbackTitle"),
    } satisfies LiveActivityLabels;
  }).current;
}

function workspaceName(agent: AgentDirectoryEntry): string | null {
  if (!agent.workspaceId) return null;
  return (
    useSessionStore.getState().sessions[agent.serverId]?.workspaces.get(agent.workspaceId)?.name ??
    null
  );
}

/** Mirrors the agents across every host into the iOS Live Activity. */
export function AgentsLiveActivitySync() {
  const native = liveActivityNative;
  const labels = useLabels();
  const { agents } = useAggregatedAgents({ demand: false });
  const [activity] = useState(() =>
    native
      ? new AgentsLiveActivity({
          native,
          title: "Paseo",
          labels,
          workspaceName,
          isForeground: () => AppState.currentState === "active",
          onError: (error) => console.warn("[live-activity]", error),
        })
      : null,
  );
  const latestAgents = useRef(agents);
  latestAgents.current = agents;

  useEffect(() => {
    activity?.sync(agents);
  }, [activity, agents]);

  useEffect(() => {
    if (!activity) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") activity.sync(latestAgents.current);
    });
    return () => subscription.remove();
  }, [activity]);

  return null;
}
