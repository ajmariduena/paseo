const FENCED_CODE = /```[\s\S]*?(```|$)/g;
const INLINE_CODE = /`([^`\n]{1,60})`|`[^`\n]*`/g;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((?:[^)\s]+)\)/g;
const URL = /\bhttps?:\/\/\S+/g;
const HTML_TAG = /<\/?[a-z][^>\n]*>/gi;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}.*$/gm;
const HEADING = /^\s{0,3}#{1,6}\s+/gm;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm;
const QUOTE_MARKER = /^\s*>\s?/gm;
const EMPHASIS = /(\*\*|__|~~)(.+?)\1|(?<![\p{L}\d])[*_](?!\s)(.+?)(?<!\s)[*_](?![\p{L}\d])/gu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX = /\b[0-9a-f]{12,}\b/gi;
const ABSOLUTE_PATH = /(?:~|\/(?:Users|home|private|tmp|var|opt|root))(?:\/[\w.@+-]+)+\/?/g;
const RELATIVE_PATH = /\b(?:[\w.@+-]+\/){2,}([\w.@+-]+)/g;
const EMOJI = /\p{Extended_Pictographic}️?/gu;

/**
 * Agent text rewritten for a voice model: markdown, code, links, ids and long paths removed or
 * reduced to what can be said aloud. Keeps the words; summarizing is the caller's job.
 */
export function toSpeakableText(text: string): string {
  return text
    .replace(FENCED_CODE, " (code) ")
    .replace(MARKDOWN_LINK, "$1")
    .replace(URL, "(link)")
    .replace(HTML_TAG, " ")
    .replace(TABLE_RULE, "")
    .replace(HEADING, "")
    .replace(LIST_MARKER, "· ")
    .replace(QUOTE_MARKER, "")
    .replace(INLINE_CODE, (_match, short: string | undefined) => shortenCode(short))
    .replace(EMPHASIS, (_match, _marker, strong?: string, soft?: string) => strong ?? soft ?? "")
    .replace(UUID, "")
    .replace(LONG_HEX, "")
    .replace(ABSOLUTE_PATH, (path) => basenameOf(path))
    .replace(RELATIVE_PATH, (_match, last: string) => last)
    .replace(EMOJI, "")
    .replace(/\|/g, ", ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/\(\s*\)/g, "")
    .trim();
}

/** One line of speakable text, cut at a sentence or word boundary. */
export function speakableClip(text: string, maxLength: number): string {
  const flat = toSpeakableText(text)
    .replace(/\s*\n\s*/g, " ")
    .trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (sentenceEnd > maxLength * 0.6) return cut.slice(0, sentenceEnd + 1);
  const wordEnd = cut.lastIndexOf(" ");
  return `${cut.slice(0, wordEnd > maxLength * 0.6 ? wordEnd : maxLength - 1).trimEnd()}…`;
}

function shortenCode(code: string | undefined): string {
  if (!code) return "";
  const trimmed = code.trim();
  if (/[/\\]/.test(trimmed)) return basenameOf(trimmed);
  return trimmed;
}

function basenameOf(path: string): string {
  const parts = path.replace(/\/+$/, "").split(/[/\\]/);
  return parts.at(-1) ?? path;
}
