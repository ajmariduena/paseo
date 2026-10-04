import type { TFunction } from "i18next";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { TurnLiveness } from "@/timeline/turn-liveness";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type SubagentStatusWord =
  | "starting"
  | "working"
  | "needsInput"
  | "failed"
  | "done"
  | "stopped"
  | "archived";

/** What a subagent row says about its child: the word, and the dot the sidebar would draw. */
export interface SubagentStatus {
  word: SubagentStatusWord;
  bucket: SidebarStateBucket;
  isLive: boolean;
}

export interface PaseoSubagentStatusInput {
  status: AgentLifecycleStatus;
  turn: TurnLiveness;
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
  isArchived: boolean;
}

export type SubagentToolCallStatus = "executing" | "running" | "completed" | "failed" | "canceled";

const LIVE_WORDS: ReadonlySet<SubagentStatusWord> = new Set(["starting", "working", "needsInput"]);

function status(word: SubagentStatusWord, bucket: SidebarStateBucket): SubagentStatus {
  return { word, bucket, isLive: LIVE_WORDS.has(word) };
}

/**
 * The child's state in the sidebar's vocabulary, so a subagent reads the same in the timeline, the
 * track and the sidebar. An unread finished child keeps the word "Done"; its dot carries the
 * attention, as the sidebar row does.
 */
export function resolvePaseoSubagentStatus(input: PaseoSubagentStatusInput | null): SubagentStatus {
  if (!input || input.isArchived) return status("archived", "done");
  if (input.pendingPermissionCount > 0 || input.attentionReason === "permission") {
    return status("needsInput", "needs_input");
  }
  if (input.status === "error") return status("failed", "failed");
  if (input.status === "initializing") return status("starting", "running");
  if (input.turn.phase === "open" || input.status === "running") {
    return status("working", "running");
  }
  return status("done", input.requiresAttention ? "attention" : "done");
}

export function resolveProviderSubagentStatus(
  descriptorStatus: ProviderSubagentDescriptorPayload["status"],
): SubagentStatus {
  switch (descriptorStatus) {
    case "running":
      return status("working", "running");
    case "failed":
      return status("failed", "failed");
    case "canceled":
      return status("stopped", "done");
    case "completed":
      return status("done", "done");
  }
}

/** The state of a spawn call whose child the client does not know yet. */
export function resolveSpawnCallStatus(
  toolCallStatus: SubagentToolCallStatus,
  kind: "paseo" | "provider",
): SubagentStatus {
  switch (toolCallStatus) {
    case "executing":
    case "running":
      return kind === "paseo" ? status("starting", "running") : status("working", "running");
    case "failed":
      return status("failed", "failed");
    case "canceled":
      return status("stopped", "done");
    case "completed":
      return status("done", "done");
  }
}

export function formatSubagentStatusWord(t: TFunction, word: SubagentStatusWord): string {
  switch (word) {
    case "starting":
      return t("subagents.status.starting");
    case "working":
      return t("subagents.status.working");
    case "needsInput":
      return t("subagents.status.needsInput");
    case "failed":
      return t("subagents.status.failed");
    case "done":
      return t("subagents.status.done");
    case "stopped":
      return t("subagents.status.stopped");
    case "archived":
      return t("subagents.status.archived");
  }
}

type SubagentSummaryBucket = "working" | "needsInput" | "failed" | "done" | "stopped";

export interface SubagentStatusCount {
  bucket: SubagentSummaryBucket;
  count: number;
}

const SUMMARY_ORDER: readonly SubagentSummaryBucket[] = [
  "working",
  "needsInput",
  "failed",
  "done",
  "stopped",
];

function summaryBucket(word: SubagentStatusWord): SubagentSummaryBucket {
  switch (word) {
    case "starting":
    case "working":
      return "working";
    case "needsInput":
      return "needsInput";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "done":
    case "archived":
      return "done";
  }
}

/** "2 working · 1 done": one count per state present, live states first. */
export function summarizeSubagentStatuses(
  statuses: readonly SubagentStatus[],
): SubagentStatusCount[] {
  const buckets = statuses.map((entry) => summaryBucket(entry.word));
  return SUMMARY_ORDER.flatMap((bucket) => {
    const count = buckets.filter((candidate) => candidate === bucket).length;
    return count > 0 ? [{ bucket, count }] : [];
  });
}

export function formatSubagentStatusCount(t: TFunction, entry: SubagentStatusCount): string {
  switch (entry.bucket) {
    case "working":
      return t("subagents.pillLabelWorking", { count: entry.count });
    case "needsInput":
      return entry.count === 1
        ? t("subagents.pillLabelNeedsInputOne")
        : t("subagents.pillLabelNeedsInputMany", { count: entry.count });
    case "failed":
      return t("subagents.pillLabelFailed", { count: entry.count });
    case "done":
      return t("subagents.summaryDone", { count: entry.count });
    case "stopped":
      return t("subagents.summaryStopped", { count: entry.count });
  }
}
