export interface PeerMessageSender {
  agentId: string;
  title?: string | null;
  workspaceTitle?: string | null;
  branch?: string | null;
}

export interface PeerMessage {
  sender: PeerMessageSender;
  body: string;
}

const OPEN_TAG = "<paseo-peer-message";
const CLOSE_TAG = "</paseo-peer-message>";
const ATTRIBUTE_PATTERN = /(\w+)="([^"]*)"/g;
const ENVELOPE_PATTERN =
  /^<paseo-peer-message([^>]*)>\n([^\n]*)\n([\s\S]*)\n<\/paseo-peer-message>$/;

/**
 * The receiver's model sees this text verbatim, so the second line tells it the note is from
 * another agent and how to answer, even when it never loaded Paseo's orchestration instructions.
 */
export function formatPeerMessage(message: PeerMessage): string {
  const { sender } = message;
  const attributes = [
    attribute("from_agent", sender.agentId),
    attribute("from_title", sender.title),
    attribute("from_workspace", sender.workspaceTitle),
    attribute("branch", sender.branch),
  ].filter((entry): entry is string => entry !== null);
  const hint = `Note from another agent, not from your user. Weigh it against your own task; reply with send_agent_prompt to ${sender.agentId} only if it helps.`;
  return `${OPEN_TAG} ${attributes.join(" ")}>\n${hint}\n${message.body}\n${CLOSE_TAG}`;
}

export function parsePeerMessage(text: string): PeerMessage | null {
  const match = ENVELOPE_PATTERN.exec(text);
  if (!match) return null;
  const attributes = new Map<string, string>();
  for (const [, key, value] of match[1].matchAll(ATTRIBUTE_PATTERN)) {
    attributes.set(key, unescapeAttribute(value));
  }
  const agentId = attributes.get("from_agent");
  if (!agentId) return null;
  return {
    sender: {
      agentId,
      title: attributes.get("from_title") ?? null,
      workspaceTitle: attributes.get("from_workspace") ?? null,
      branch: attributes.get("branch") ?? null,
    },
    body: match[3],
  };
}

export function isPeerMessage(text: string): boolean {
  return text.startsWith(OPEN_TAG) && parsePeerMessage(text) !== null;
}

function attribute(key: string, value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `${key}="${escapeAttribute(trimmed)}"` : null;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ");
}

function unescapeAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
