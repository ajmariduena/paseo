import type { TFunction } from "i18next";
import type { PaseoActivity, PaseoActivityCount } from "./model";

const COUNTLESS_ACTIVITIES: ReadonlySet<PaseoActivity> = new Set([
  "listedAgents",
  "checkedCapabilities",
]);

function plural(count: number): "one" | "other" {
  return count === 1 ? "one" : "other";
}

/** "sent 2 prompts to 1 agent", or "tried to …" when every call failed. */
export function formatPaseoActivity(t: TFunction, entry: PaseoActivityCount): string {
  const key = `toolCallGroup.paseo.${entry.activity}${entry.failedOnly ? "Failed" : ""}`;
  if (COUNTLESS_ACTIVITIES.has(entry.activity)) {
    return t(key);
  }
  const agents = t(`toolCallGroup.paseo.agentCount.${plural(entry.agentCount)}`, {
    count: entry.agentCount,
  });
  return t(`${key}.${plural(entry.count)}`, { count: entry.count, agents });
}
