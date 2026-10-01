import type { ForgeLinkRef } from "@getpaseo/protocol/messages";

export interface ParsedForgeLink extends ForgeLinkRef {
  kind: "pull_request" | "issue";
  key: string;
}

// github.com only: the daemon resolves summaries through gh's github.com login, and
// a self-hosted host taken from chat text is not trusted to receive that token.
const GITHUB_LINK_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i;

export function parseForgeLink(href: string): ParsedForgeLink | null {
  const match = href.trim().match(GITHUB_LINK_PATTERN);
  if (!match) {
    return null;
  }
  const [, owner, repo, segment, digits] = match;
  const number = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  const host = "github.com";
  return {
    host,
    owner,
    repo,
    number,
    kind: segment.toLowerCase() === "pull" ? "pull_request" : "issue",
    key: `${host}/${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`,
  };
}
