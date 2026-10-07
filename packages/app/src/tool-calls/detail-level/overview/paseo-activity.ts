import type { TFunction } from "i18next";
import type { PaseoActivity, PaseoActivityCount } from "./model";

const COUNTLESS_ACTIVITIES: ReadonlySet<PaseoActivity> = new Set([
  "listedAgents",
  "checkedCapabilities",
]);

function plural(count: number): "one" | "other" {
  return count === 1 ? "one" : "other";
}

/**
 * "sent 2 prompts to 1 agent", or "tried to …" when every call failed. A single note names
 * its recipient once its title is known: "sent a note to {title}".
 */
export function formatPaseoActivity(
  t: TFunction,
  entry: PaseoActivityCount,
  soleAgentTitle?: string | null,
): string {
  const failed = entry.failedOnly ? "Failed" : "";
  if (entry.activity === "sentNotes" && entry.count === 1 && soleAgentTitle) {
    return t(`toolCallGroup.paseo.sentNoteTo${failed}`, { title: soleAgentTitle });
  }
  const key = `toolCallGroup.paseo.${entry.activity}${failed}`;
  if (COUNTLESS_ACTIVITIES.has(entry.activity)) {
    return t(key);
  }
  const agents = t(`toolCallGroup.paseo.agentCount.${plural(entry.agentCount)}`, {
    count: entry.agentCount,
  });
  return t(`${key}.${plural(entry.count)}`, { count: entry.count, agents });
}
