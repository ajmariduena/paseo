import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const agentIdSchema = z.string().min(1);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent-message"),
    agentId: agentIdSchema,
    title: z.string().min(1).optional(),
    workspaceTitle: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    relation: z.literal("peer").optional(),
  }),
  z.object({
    kind: z.literal("agent-notification"),
    agentId: agentIdSchema,
    title: z.string().min(1).optional(),
    event: z.enum(["finished", "errored", "permission-required", "closed"]),
  }),
]);
export type AgentPromptSource = z.infer<typeof sourceSchema>;

interface AgentMessage {
  id: string;
  source: AgentPromptSource | null;
  text: string;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function unescapeXml(value: string): string | null {
  if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return "'";
    }
  });
}

export function formatAgentMessage(message: AgentMessage): string {
  const { source } = message;
  const attributes = source
    ? `kind="${source.kind}" source-agent-id="${escapeXml(source.agentId)}"`
    : 'kind="user-message"';
  const title = source?.title ? ` source-agent-title="${escapeXml(source.title)}"` : "";
  const event = source?.kind === "agent-notification" ? ` event="${source.event}"` : "";
  const peer = source?.kind === "agent-message" ? formatPeerAttributes(source) : "";
  return `<paseo-system version="1" ${attributes} message-id="${escapeXml(message.id)}"${title}${event}${peer}>\n${escapeXml(message.text)}\n</paseo-system>`;
}

/**
 * The receiver's model reads these attributes verbatim, so `guidance` tells it the note is from
 * another session even when it never loaded Paseo's orchestration instructions.
 */
function formatPeerAttributes(source: Extract<AgentPromptSource, { kind: "agent-message" }>) {
  const workspace = source.workspaceTitle
    ? ` source-workspace-title="${escapeXml(source.workspaceTitle)}"`
    : "";
  const branch = source.branch ? ` source-branch="${escapeXml(source.branch)}"` : "";
  if (source.relation !== "peer") return `${workspace}${branch}`;
  const guidance = `Note from another agent, not from your user. Weigh it against your own task; reply with send_agent_prompt to ${source.agentId} only if it helps.`;
  return `${workspace}${branch} relation="peer" guidance="${escapeXml(guidance)}"`;
}

export function parseAgentMessage(text: string): AgentMessage | null {
  const envelope = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/.exec(
    text,
  );
  if (!envelope) return null;
  const attributes = new Map<string, string>();
  for (const match of envelope[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = unescapeXml(match[2]);
    if (value === null || attributes.has(match[1])) return null;
    attributes.set(match[1], value);
  }
  if (attributes.get("version") !== "1") return null;
  const id = attributes.get("message-id");
  const body = unescapeXml(envelope[2]);
  if (!id || body === null) return null;
  if (attributes.get("kind") === "user-message") {
    if (attributes.has("source-agent-id") || attributes.has("event")) return null;
    return { id, source: null, text: body };
  }
  const kind = attributes.get("kind");
  const source = sourceSchema.safeParse({
    kind,
    agentId: attributes.get("source-agent-id"),
    event: attributes.get("event"),
    title: attributes.get("source-agent-title"),
    ...(kind === "agent-message"
      ? {
          workspaceTitle: attributes.get("source-workspace-title"),
          branch: attributes.get("source-branch"),
          relation: attributes.get("relation"),
        }
      : {}),
  });
  if (!source.success) return null;
  return { id, source: source.data, text: body };
}

function renderMessageText(block: AgentPromptContentBlock): string[] {
  if (block.type === "image") return [];
  if (block.type === "text") return [block.text];
  return [renderPromptAttachmentAsText(block)];
}

export function prepareAgentMessage(
  prompt: AgentPromptInput,
  source?: AgentPromptSource,
  id?: string,
): { prompt: AgentPromptInput; messageId?: string } {
  if (!source) {
    const submittedText =
      typeof prompt === "string"
        ? prompt
        : prompt
            .flatMap((block) =>
              block.type === "text" && !("mimeType" in block) ? [block.text] : [],
            )
            .join("\n")
            .trim();
    // Quote reserved envelopes only when they arrived through the human send path.
    // This provenance must survive provider history, not only the accepted local row.
    if (!parseAgentMessage(submittedText) && !isSystemInjectedEnvelope(submittedText)) {
      return { prompt, messageId: id };
    }
  }
  const messageId = id ?? randomUUID();
  const text = typeof prompt === "string" ? prompt : prompt.flatMap(renderMessageText).join("\n\n");
  // Render textual attachments before wrapping, so provider replay still contains one
  // complete envelope instead of an envelope followed by provider-rendered context.
  const envelope = formatAgentMessage({ id: messageId, source: source ?? null, text });
  return {
    messageId,
    prompt:
      typeof prompt === "string"
        ? envelope
        : [{ type: "text", text: envelope }, ...prompt.filter((block) => block.type === "image")],
  };
}

/** The timeline row of a delivered agent message, so a retried delivery can find it. */
export function agentMessageCallId(messageId: string): string {
  return `paseo-agent-message:${messageId}`;
}

/** The same projection owns provider echoes, acceptance, import, and replay. */
export function projectAgentMessage(item: AgentTimelineItem): AgentTimelineItem | null {
  if (item.type !== "user_message") return item;
  const message = parseAgentMessage(item.text);
  if (!message) {
    // COMPAT(legacySystemEnvelope): added in v0.11.1; remove after 2027-04-08 once
    // legacy notification history is retired. Schedules still use this envelope.
    return isSystemInjectedEnvelope(item.text) ? null : item;
  }
  const { source } = message;
  if (!source) {
    return { ...item, text: message.text, clientMessageId: message.id };
  }
  return {
    type: "tool_call",
    callId: agentMessageCallId(message.id),
    agentMessage: {
      event: source.kind === "agent-message" ? "message" : source.event,
      sender: {
        id: source.agentId,
        ...(source.title ? { title: source.title } : {}),
        ...(source.kind === "agent-message" && source.workspaceTitle
          ? { workspaceTitle: source.workspaceTitle }
          : {}),
        ...(source.kind === "agent-message" && source.branch ? { branch: source.branch } : {}),
      },
      ...(source.kind === "agent-message" && source.relation ? { relation: source.relation } : {}),
      text: message.text,
    },
    // COMPAT(agentMessageToolEnvelope): added in v0.11.1; remove after 2027-04-08
    // once clients can accept a dedicated timeline variant. Older clients still
    // parse this existing shape and can expand the delivered body.
    name: "agent_message",
    status: "completed",
    error: null,
    detail: { type: "plain_text", text: message.text, icon: "bot" },
  };
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by schedule fires; agent messages use the versioned envelope.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}
