import type { StreamItem } from "@/types/stream";
import { isSubagentNotification } from "@/subagents/timeline/notification-source";

/**
 * Canonical turn IDs take precedence. Timelines without them retain the legacy
 * user-message boundary rule so old daemons and persisted rows need no rewrite.
 */
export function continuesTurn(previous: StreamItem | null, next: StreamItem | null): boolean {
  if (!previous || !next) return false;
  if (previous.turnId !== undefined && next.turnId !== undefined) {
    return previous.turnId === next.turnId;
  }
  return next.kind !== "user_message";
}

/**
 * A visible response can span multiple canonical turns when their prompts are
 * system-injected and therefore absent from the Paseo timeline. A subagent wake is the
 * visible cause of the response after it, so it starts one the way a user message does.
 */
export function continuesResponse(previous: StreamItem | null, next: StreamItem | null): boolean {
  if (!previous || !next) return false;
  return continuesTurn(previous, next) || !startsResponse(next);
}

function startsResponse(item: StreamItem): boolean {
  return item.kind === "user_message" || isSubagentNotification(item);
}

export function isTurnBoundary(previous: StreamItem | null, next: StreamItem | null): boolean {
  return previous !== null && next !== null && !continuesTurn(previous, next);
}

export function isResponseBoundary(previous: StreamItem | null, next: StreamItem | null): boolean {
  return previous !== null && next !== null && !continuesResponse(previous, next);
}

/** Whether `item` begins a new chronological turn after `previous`. */
export function startsNewTurn(item: StreamItem, previous: StreamItem | null): boolean {
  return previous === null || isTurnBoundary(previous, item);
}

export function belongsToTurn(item: StreamItem, turnId: string | null): boolean {
  return turnId !== null && item.turnId === turnId;
}
