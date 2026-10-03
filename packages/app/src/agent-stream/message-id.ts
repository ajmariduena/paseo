import type { StreamItem } from "@/types/stream";

/**
 * The source message a display row belongs to. Every assistant message is split into
 * Markdown blocks, so an assistant row id never equals its message id; anything that
 * addresses a message — find, scroll-to-message, history reveal — asks for this.
 */
export function getStreamItemMessageId(item: StreamItem): string {
  return item.kind === "assistant_message" ? (item.blockGroupId ?? item.id) : item.id;
}
