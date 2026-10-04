import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import type { StreamItem, ToolCallItem } from "@/types/stream";

const MAX_EXCERPT_LENGTH = 280;

/** Markdown reduced to the words a two-line excerpt can show. */
export function toPlainExcerpt(markdown: string): string | null {
  const plain = markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  return plain.length > MAX_EXCERPT_LENGTH ? `${plain.slice(0, MAX_EXCERPT_LENGTH - 1)}…` : plain;
}

function describeToolCallActivity(item: ToolCallItem): string | null {
  if (item.payload.source !== "agent") return null;
  const { data } = item.payload;
  const display = buildToolCallDisplayModel({
    name: data.name,
    status: data.status,
    error: data.error ?? null,
    detail: data.detail,
    metadata: data.metadata,
  });
  const line = display.summary ? `${display.displayName} ${display.summary}` : display.displayName;
  return toPlainExcerpt(line);
}

/**
 * The line a subagent row shows under its title: a settled child's last answer, or what a live
 * child is doing right now.
 */
export function selectSubagentExcerpt(input: {
  items: readonly StreamItem[];
  isLive: boolean;
}): string | null {
  for (let index = input.items.length - 1; index >= 0; index -= 1) {
    const item = input.items[index];
    if (!item) continue;
    if (item.kind === "assistant_message") {
      const excerpt = toPlainExcerpt(item.text);
      if (excerpt) return excerpt;
      continue;
    }
    if (input.isLive && item.kind === "tool_call") {
      const activity = describeToolCallActivity(item);
      if (activity) return activity;
    }
  }
  return null;
}
