import type { TFunction } from "i18next";
import { parsePeerMessage, type PeerMessage } from "@getpaseo/protocol/peer-message";
import type { SessionState } from "@/stores/session-store";
import type { StreamItem, ToolCallItem, UserMessageItem } from "@/types/stream";

export type PeerNote = PeerMessage;

const OPEN_TAG = "<paseo-peer-message";
const ATTRIBUTE_PATTERN = /(\w+)="([^"]*)"/g;
const SHORT_AGENT_ID_LENGTH = 8;

const noteByItem = new WeakMap<UserMessageItem, PeerNote | null>();

/** The note another session sent, when this row is one. */
export function readPeerNote(item: StreamItem | null | undefined): PeerNote | null {
  if (item?.kind === "tool_call") return readAgentMessageNote(item);
  if (item?.kind !== "user_message") return null;
  // COMPAT(peerMessageEnvelope): notes sent before the fork adopted upstream's agent-message
  // envelope arrive as user messages; remove after 2027-04-08.
  const cached = noteByItem.get(item);
  if (cached !== undefined) return cached;
  const note = item.text.startsWith(OPEN_TAG) ? parsePeerMessage(item.text) : null;
  noteByItem.set(item, note);
  return note;
}

const noteByToolCall = new WeakMap<ToolCallItem, PeerNote | null>();

function readAgentMessageNote(item: ToolCallItem): PeerNote | null {
  const cached = noteByToolCall.get(item);
  if (cached !== undefined) return cached;
  const message = item.payload.source === "agent" ? item.payload.data.agentMessage : undefined;
  const note =
    message?.relation === "peer"
      ? {
          sender: {
            agentId: message.sender.id,
            title: message.sender.title ?? null,
            workspaceTitle: message.sender.workspaceTitle ?? null,
            branch: message.sender.branch ?? null,
          },
          body: message.text,
        }
      : null;
  noteByToolCall.set(item, note);
  return note;
}

export function isPeerNote(item: StreamItem | null | undefined): boolean {
  return readPeerNote(item) !== null;
}

/** A user message the user wrote, or another agent sent as a prompt, but not a peer note. */
export function isOwnUserMessage(item: StreamItem | null | undefined): item is UserMessageItem {
  return item?.kind === "user_message" && !isPeerNote(item);
}

/** The name a note is from: its workspace, then the sender's title, then a short id. */
export function resolvePeerNoteSenderName(
  sender: PeerNote["sender"],
  liveTitle?: string | null,
): string {
  return (
    sender.workspaceTitle?.trim() ||
    sender.title?.trim() ||
    liveTitle?.trim() ||
    sender.agentId.slice(0, SHORT_AGENT_ID_LENGTH)
  );
}

/** The body on one line, for a collapsed row or a preview. */
export function excerptPeerNote(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/**
 * A server-built preview cuts the envelope short, so only the opening tag survives.
 * Reads the sender from whatever attributes it still holds.
 */
export function readPeerNotePreviewSender(preview: string): PeerNote["sender"] | null {
  if (!preview.startsWith(OPEN_TAG)) return null;
  const tagEnd = preview.indexOf(">");
  const tag = tagEnd < 0 ? preview : preview.slice(0, tagEnd);
  const attributes = new Map<string, string>();
  for (const [, key, value] of tag.matchAll(ATTRIBUTE_PATTERN)) {
    attributes.set(key, value.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  }
  const agentId = attributes.get("from_agent");
  if (!agentId) return null;
  return {
    agentId,
    title: attributes.get("from_title") ?? null,
    workspaceTitle: attributes.get("from_workspace") ?? null,
    branch: attributes.get("branch") ?? null,
  };
}

/** "Note from {name}" for a preview that holds a peer note's envelope; any other preview as is. */
export function formatPromptPreview(t: TFunction, preview: string): string {
  const sender = readPeerNotePreviewSender(preview);
  return sender ? t("message.peerNote.from", { name: resolvePeerNoteSenderName(sender) }) : preview;
}

/** Agent ids are unique across hosts, so a row that does not know its host can still look one up. */
export function findAgentTitle(
  sessions: Readonly<Record<string, SessionState>>,
  agentId: string,
): string | null {
  for (const session of Object.values(sessions)) {
    const agent = session.agents.get(agentId) ?? session.agentDetails.get(agentId);
    const title = agent?.title?.trim();
    if (title) return title;
  }
  return null;
}
