import type { ForgeLinkSummary } from "@getpaseo/protocol/messages";
import type { ParsedForgeLink } from "@/git/forge-link-ref";

const TITLE_MAX_CHARS = 48;

export type ForgeLinkTone = "neutral" | "open" | "merged" | "closed" | "draft";
export type ForgeLinkGlyph =
  | "pull_request"
  | "pull_request_merged"
  | "pull_request_closed"
  | "pull_request_draft"
  | "issue"
  | "issue_closed";

export interface ForgeLinkChipPresentation {
  tone: ForgeLinkTone;
  glyph: ForgeLinkGlyph;
  label: string;
  title: string | null;
  checks: ForgeLinkSummary["checksStatus"];
}

function truncateTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > TITLE_MAX_CHARS
    ? `${trimmed.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
    : trimmed;
}

export function presentForgeLinkChip(
  link: ParsedForgeLink,
  summary: ForgeLinkSummary | null,
): ForgeLinkChipPresentation {
  const label = `#${link.number}`;
  const kind = summary?.available ? (summary.kind ?? link.kind) : link.kind;
  const neutral: ForgeLinkChipPresentation = {
    tone: "neutral",
    glyph: kind === "issue" ? "issue" : "pull_request",
    label,
    title: null,
    checks: null,
  };
  if (!summary?.available || !summary.state) {
    return neutral;
  }
  const title = summary.title ? truncateTitle(summary.title) : null;
  if (kind === "issue") {
    return summary.state === "open"
      ? { tone: "open", glyph: "issue", label, title, checks: null }
      : { tone: "merged", glyph: "issue_closed", label, title, checks: null };
  }
  if (summary.state === "merged") {
    return { tone: "merged", glyph: "pull_request_merged", label, title, checks: null };
  }
  if (summary.state === "closed") {
    return { tone: "closed", glyph: "pull_request_closed", label, title, checks: null };
  }
  return summary.draft
    ? { tone: "draft", glyph: "pull_request_draft", label, title, checks: summary.checksStatus }
    : { tone: "open", glyph: "pull_request", label, title, checks: summary.checksStatus };
}
