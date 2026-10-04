import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { curateAgentActivity } from "./activity-curator.js";

export const DEFAULT_ACTIVITY_PAGE_LIMIT = 50;
export const MAX_ACTIVITY_PAGE_LIMIT = 100;
export const DEFAULT_MAX_CHARS_PER_ITEM = 20_000;
export const MAX_CHARS_PER_ITEM = 50_000;

export type ActivityView = "activity" | "messages";

export interface ActivityRow {
  seq: number;
  item: AgentTimelineItem;
}

export interface ActivityPageItem {
  position: number;
  kind: AgentTimelineItem["type"];
  text: string;
  textOffset: number;
  textTruncated: boolean;
  nextTextOffset?: number;
}

export interface ActivityPage {
  items: ActivityPageItem[];
  /** Pass as afterPosition to read what comes next. */
  nextPosition: number;
  hasMore: boolean;
  hasOlder: boolean;
  /** Whether the timeline's final assistant message is on this page, whole. */
  includesFinalAssistantMessage: boolean;
}

export interface ActivityPageRequest {
  rows: readonly ActivityRow[];
  view: ActivityView;
  /** Omit for the latest page. */
  afterPosition?: number;
  limit: number;
  maxCharsPerItem: number;
  /** Reads one item's text from `textOffset` instead of a page. */
  itemPosition?: number;
  textOffset?: number;
}

const MESSAGE_KINDS = new Set<AgentTimelineItem["type"]>(["user_message", "assistant_message"]);

function itemText(item: AgentTimelineItem): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    default:
      return curateAgentActivity([item]);
  }
}

/** Offsets count UTF-16 code units, like T3's thread read. */
function toPageItem(row: ActivityRow, maxChars: number, textOffset = 0): ActivityPageItem {
  const full = itemText(row.item);
  const end = textOffset + maxChars;
  const textTruncated = end < full.length;
  return {
    position: row.seq,
    kind: row.item.type,
    text: full.slice(textOffset, end),
    textOffset,
    textTruncated,
    ...(textTruncated ? { nextTextOffset: end } : {}),
  };
}

export function readActivityPage(request: ActivityPageRequest): ActivityPage {
  const lastSeq = request.rows.at(-1)?.seq ?? 0;
  const finalAssistant = request.rows.findLast((row) => row.item.type === "assistant_message");
  function isWholeFinalAssistant(item: ActivityPageItem): boolean {
    return (
      finalAssistant !== undefined &&
      item.position === finalAssistant.seq &&
      item.textOffset === 0 &&
      !item.textTruncated
    );
  }

  if (request.itemPosition !== undefined) {
    const row = request.rows.find((candidate) => candidate.seq === request.itemPosition);
    if (!row) {
      throw new Error(`No activity item at position ${request.itemPosition}`);
    }
    const item = toPageItem(row, request.maxCharsPerItem, request.textOffset ?? 0);
    return {
      items: [item],
      nextPosition: lastSeq,
      hasMore: false,
      hasOlder: false,
      includesFinalAssistantMessage: isWholeFinalAssistant(item),
    };
  }

  const visible = request.rows.filter(
    (row) => request.view === "activity" || MESSAGE_KINDS.has(row.item.type),
  );
  let selected: ActivityRow[];
  let hasMore = false;
  let hasOlder = false;
  const { afterPosition } = request;
  if (afterPosition === undefined) {
    selected = visible.slice(-request.limit);
    hasOlder = visible.length > selected.length;
  } else {
    const after = visible.filter((row) => row.seq > afterPosition);
    selected = after.slice(0, request.limit);
    hasMore = after.length > selected.length;
    hasOlder = visible.length > after.length;
  }
  const items = selected.map((row) => toPageItem(row, request.maxCharsPerItem));
  return {
    items,
    nextPosition: hasMore ? (selected.at(-1)?.seq ?? lastSeq) : lastSeq,
    hasMore,
    hasOlder,
    includesFinalAssistantMessage: items.some(isWholeFinalAssistant),
  };
}
