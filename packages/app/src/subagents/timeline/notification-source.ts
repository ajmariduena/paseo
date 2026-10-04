import type { SubagentNotificationEntry } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";

/** The children a daemon notification reports on; empty for any other notification. */
export function readSubagentNotificationEntries(
  item: StreamItem,
): readonly SubagentNotificationEntry[] {
  if (item.kind !== "notification" || item.source?.kind !== "subagent") return [];
  return item.source.subagents;
}

export function isSubagentNotification(item: StreamItem): boolean {
  return readSubagentNotificationEntries(item).length > 0;
}
