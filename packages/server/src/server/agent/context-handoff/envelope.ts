import type { AgentPromptInput } from "../agent-sdk-types.js";
import { HandoffInputError } from "./types.js";
import type { EnvelopeMetadata } from "./types.js";

const USER_MESSAGE = "\n\nUser message:\n";
const CLOSE = `\n</paseo-context-handoff>${USER_MESSAGE}`;
const OPEN = /^<paseo-context-handoff v="1" id="([^"<>]*)" from="([^"<>]*)" to="([^"<>]*)">\n/;

interface EnvelopeInput extends EnvelopeMetadata {
  history: string;
}

interface UnwrapInput {
  prompt: AgentPromptInput;
  // Unconsumed ids only; retire the returned attemptId after reconciling its real message.
  knownAttemptIds: ReadonlySet<string>;
  // Bind this to the message's persisted attempt, never to an id read from its text.
  expectedAttemptId: string | null;
}

export interface UnwrappedHandoffPrompt {
  prompt: AgentPromptInput;
  attemptId: string | null;
}

interface EnvelopeMatch {
  attemptId: string;
  end: number;
}

export function escapeHandoffText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function escapeAttribute(text: string): string {
  return escapeHandoffText(text)
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeAttribute(text: string): string | null {
  const decoded = text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
  return escapeAttribute(decoded) === text ? decoded : null;
}

export function renderEnvelope(input: EnvelopeInput): string {
  for (const field of ["id", "from", "to"] as const) {
    if (input[field].length === 0) throw new HandoffInputError(field);
  }
  return `<paseo-context-handoff v="1" id="${escapeAttribute(input.id)}" from="${escapeAttribute(input.from)}" to="${escapeAttribute(input.to)}">\n${escapeHandoffText(input.history)}${CLOSE}`;
}

function matchEnvelope(text: string, input: UnwrapInput): EnvelopeMatch | null {
  const match = OPEN.exec(text);
  if (!match) return null;
  const [, encodedId, encodedFrom, encodedTo] = match;
  const id = unescapeAttribute(encodedId!);
  const from = unescapeAttribute(encodedFrom!);
  const to = unescapeAttribute(encodedTo!);
  const validAttributes =
    id && from && to && input.knownAttemptIds.has(id) && id === input.expectedAttemptId;
  if (!validAttributes) return null;
  const closeAt = text.indexOf(CLOSE, match[0].length);
  if (closeAt < 0) return null;
  const body = text.slice(match[0].length, closeAt);
  const decoded = body.replaceAll("&lt;", "<").replaceAll("&amp;", "&");
  if (escapeHandoffText(decoded) !== body) return null;
  return { attemptId: id, end: closeAt + CLOSE.length };
}

export function unwrapHandoffPrompt(input: UnwrapInput): UnwrappedHandoffPrompt {
  const unchanged: UnwrappedHandoffPrompt = { prompt: input.prompt, attemptId: null };
  if (typeof input.prompt === "string") {
    const match = matchEnvelope(input.prompt, input);
    if (match === null) return unchanged;
    return { prompt: input.prompt.slice(match.end), attemptId: match.attemptId };
  }
  const first = input.prompt[0];
  if (first?.type !== "text" || "mimeType" in first) return unchanged;
  const match = matchEnvelope(first.text, input);
  if (match === null) return unchanged;
  const rest = input.prompt.slice(1);
  if (match.end === first.text.length) return { prompt: rest, attemptId: match.attemptId };
  return {
    prompt: [{ ...first, text: first.text.slice(match.end) }, ...rest],
    attemptId: match.attemptId,
  };
}
