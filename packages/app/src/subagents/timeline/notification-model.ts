import type { TFunction } from "i18next";
import type {
  ProviderSnapshotEntry,
  SubagentNotificationEntry,
  SubagentNotificationReason,
} from "@getpaseo/protocol/agent-types";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { formatAgentModelLabel, joinAgentModelLabel } from "../presentation/model-label";
import { resolveRowLabel } from "../track-presentation";
import type { SpawnedAgentSnapshot, SubagentOpenTarget } from "./model";

export type SubagentNotificationWord = "finished" | "failed" | "needsInput" | "closed";

export interface SubagentNotificationRowModel {
  key: string;
  agentId: string;
  provider: string | null;
  title: string | null;
  /** The event the wake reported, frozen: the child's later state does not change it. */
  word: SubagentNotificationWord;
  bucket: SidebarStateBucket;
  durationMs: number | null;
  modelLabel: string | null;
  target: SubagentOpenTarget;
}

function reasonPresentation(reason: SubagentNotificationReason): {
  word: SubagentNotificationWord;
  bucket: SidebarStateBucket;
} {
  switch (reason) {
    case "finished":
      return { word: "finished", bucket: "attention" };
    case "errored":
      return { word: "failed", bucket: "failed" };
    case "needs_permission":
      return { word: "needsInput", bucket: "needs_input" };
    case "closed":
      return { word: "closed", bucket: "done" };
  }
}

/**
 * One row per child the notification names. A child the client no longer knows keeps the
 * notification's own title and still opens by id.
 */
export function resolveSubagentNotificationRows(input: {
  notificationId: string;
  entries: readonly SubagentNotificationEntry[];
  agents: readonly (SpawnedAgentSnapshot | null)[];
  providerEntries: readonly ProviderSnapshotEntry[] | undefined;
}): SubagentNotificationRowModel[] {
  return input.entries.map((entry, index) => {
    const agent = input.agents[index] ?? null;
    const modelLabel = agent
      ? joinAgentModelLabel(
          formatAgentModelLabel(
            { provider: agent.provider, model: agent.runtimeInfo?.model ?? agent.model },
            input.providerEntries,
          ),
        )
      : null;
    return {
      key: `${input.notificationId}:${index}:${entry.agentId}`,
      agentId: entry.agentId,
      provider: agent?.provider ?? null,
      title: resolveRowLabel(agent?.title) ?? resolveRowLabel(entry.title),
      ...reasonPresentation(entry.reason),
      durationMs: entry.durationMs ?? null,
      modelLabel,
      target: { kind: "agent", agentId: entry.agentId },
    };
  });
}

export function formatSubagentNotificationWord(
  t: TFunction,
  word: SubagentNotificationWord,
): string {
  switch (word) {
    case "finished":
      return t("subagents.status.finished");
    case "failed":
      return t("subagents.status.failed");
    case "needsInput":
      return t("subagents.status.needsInput");
    case "closed":
      return t("subagents.status.closed");
  }
}
