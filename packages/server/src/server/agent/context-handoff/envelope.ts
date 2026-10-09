import type { AgentPromptInput } from "../agent-sdk-types.js";
import { HandoffInputError } from "./budget.js";
import type { EnvelopeMetadata } from "./types.js";

const USER_MESSAGE = "\n\nUser message:\n";
const CLOSE = `\n</paseo-context-handoff>${USER_MESSAGE}`;
const OPEN = /^<paseo-context-handoff v="1" id="([^"<>]*)" from="([^"<>]*)" to="([^"<>]*)">\n/;

interface EnvelopeInput extends EnvelopeMetadata {
  history: string;
}

interface UnwrapInput {
  prompt: AgentPromptInput;
  knownAttemptIds: ReadonlySet<string>;
}

export function escapeHandoffText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeHandoffText(text: string): string | null {
  const decoded = text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
  return escapeHandoffText(decoded) === text ? decoded : null;
}

export function renderEnvelope(input: EnvelopeInput): string {
  for (const field of ["id", "from", "to"] as const) {
    if (input[field].length === 0) throw new HandoffInputError(field);
  }
  return `<paseo-context-handoff v="1" id="${escapeHandoffText(input.id)}" from="${escapeHandoffText(input.from)}" to="${escapeHandoffText(input.to)}">\n${escapeHandoffText(input.history)}${CLOSE}`;
}

function envelopeEnd(text: string, knownAttemptIds: ReadonlySet<string>): number | null {
  const match = OPEN.exec(text);
  if (!match) return null;
  const [, encodedId, encodedFrom, encodedTo] = match;
  const id = unescapeHandoffText(encodedId!);
  const from = unescapeHandoffText(encodedFrom!);
  const to = unescapeHandoffText(encodedTo!);
  const validAttributes = id && from && to && knownAttemptIds.has(id);
  if (!validAttributes) return null;
  const closeAt = text.indexOf(CLOSE, match[0].length);
  if (closeAt < 0) return null;
  const body = text.slice(match[0].length, closeAt);
  if (unescapeHandoffText(body) === null) return null;
  return closeAt + CLOSE.length;
}

export function unwrapHandoffPrompt(input: UnwrapInput): AgentPromptInput {
  if (typeof input.prompt === "string") {
    const end = envelopeEnd(input.prompt, input.knownAttemptIds);
    return end === null ? input.prompt : input.prompt.slice(end);
  }
  const first = input.prompt[0];
  if (first?.type !== "text" || "mimeType" in first) return input.prompt;
  const end = envelopeEnd(first.text, input.knownAttemptIds);
  if (end === null) return input.prompt;
  const rest = input.prompt.slice(1);
  if (end === first.text.length) return rest;
  return [{ ...first, text: first.text.slice(end) }, ...rest];
}
