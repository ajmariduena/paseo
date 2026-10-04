import type { AgentQueueSnapshot } from "@getpaseo/protocol/messages";

export type ServerQueueEntry = AgentQueueSnapshot["entries"][number];

/** The daemon cuts `textPreview` at this many characters (`agent-queue/store.ts`). */
const DAEMON_PREVIEW_CHARS = 200;

/**
 * Who a queued entry is from, as the row labels it. A user's own entry carries no label; the
 * rest name where they came from so they are never mistaken for something the user typed.
 */
export type QueueEntrySource =
  | { kind: "user" }
  | { kind: "agent"; senderAgentId: string | null }
  | { kind: "subagent_results" }
  | { kind: "notification" };

export function resolveQueueEntrySource(entry: ServerQueueEntry): QueueEntrySource {
  switch (entry.origin) {
    case "user":
      return { kind: "user" };
    case "agent":
      return { kind: "agent", senderAgentId: entry.senderAgentId };
    case "delegation_wake":
      return { kind: "subagent_results" };
    case "system":
      return { kind: "notification" };
  }
}

/**
 * The full text to edit, or null when the entry can't be edited without losing text. Wakes and
 * notifications are rendered by the daemon at delivery, so they have no text to edit. A preview at
 * the daemon's cut may be truncated; only the text this app queued itself is known to be whole.
 */
export function resolveEditableQueueText(
  entry: ServerQueueEntry,
  knownText: string | null,
): string | null {
  if (entry.origin !== "user" && entry.origin !== "agent") return null;
  if (knownText !== null) return knownText;
  return entry.textPreview.length < DAEMON_PREVIEW_CHARS ? entry.textPreview : null;
}

/** Subagent results always go first, so they never move; every other entry moves among its peers. */
export function canMoveQueueEntry(entry: ServerQueueEntry): boolean {
  return entry.origin !== "delegation_wake";
}

export interface QueueEntryMoves {
  up: string[] | null;
  down: string[] | null;
}

/**
 * The full order to send `agent.queue.reorder` for moving one entry a step, or null when it
 * can't move that way. Entries arrive in delivery order, wakes first.
 */
export function resolveQueueEntryMoves(
  entries: readonly ServerQueueEntry[],
  entryId: string,
): QueueEntryMoves {
  const pinned = entries.filter((entry) => !canMoveQueueEntry(entry)).map((entry) => entry.id);
  const movable = entries.filter(canMoveQueueEntry).map((entry) => entry.id);
  const index = movable.indexOf(entryId);
  if (index < 0) return { up: null, down: null };
  return {
    up: index > 0 ? [...pinned, ...swap(movable, index, index - 1)] : null,
    down: index < movable.length - 1 ? [...pinned, ...swap(movable, index, index + 1)] : null,
  };
}

function swap(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  next[from] = ids[to];
  next[to] = ids[from];
  return next;
}

/**
 * The entry the steer-first-queued shortcut sends into the running turn: the oldest message a
 * user or agent wrote. Subagent results and notifications already steer on their own when the
 * provider can take them, so one still queued is waiting for the turn to end.
 */
export function resolveFirstQueuedMessageId(entries: readonly ServerQueueEntry[]): string | null {
  const first = entries.find((entry) => entry.origin === "user" || entry.origin === "agent");
  return first?.id ?? null;
}

type HeldReason = AgentQueueSnapshot["heldReason"];

const HELD_TITLE_KEYS: Record<NonNullable<HeldReason>, string> = {
  restart: "composer.queue.held.restart",
  failure: "composer.queue.held.failure",
  user_stop: "composer.queue.held.userStop",
};

/** Why the daemon stopped draining the queue, as the held callout says it. */
export function resolveHeldQueueTitleKey(reason: HeldReason): string {
  return reason ? HELD_TITLE_KEYS[reason] : "composer.queue.held.paused";
}
