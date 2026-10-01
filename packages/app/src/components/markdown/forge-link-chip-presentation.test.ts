import type { ForgeLinkSummary } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { parseForgeLink, type ParsedForgeLink } from "@/git/forge-link-ref";
import { presentForgeLinkChip } from "./forge-link-chip-presentation";

const pr = parseForgeLink("https://github.com/getpaseo/paseo/pull/5729") as ParsedForgeLink;
const issue = parseForgeLink("https://github.com/getpaseo/paseo/issues/5730") as ParsedForgeLink;

function summary(overrides: Partial<ForgeLinkSummary>): ForgeLinkSummary {
  return {
    host: "github.com",
    owner: "getpaseo",
    repo: "paseo",
    number: 5729,
    kind: "pull_request",
    state: "open",
    draft: false,
    title: "Keep the context meter",
    checksStatus: null,
    available: true,
    ...overrides,
  };
}

describe("presentForgeLinkChip", () => {
  it("stays neutral until a summary is available", () => {
    expect(presentForgeLinkChip(pr, null)).toMatchObject({ tone: "neutral", label: "#5729" });
    expect(presentForgeLinkChip(issue, summary({ available: false }))).toMatchObject({
      tone: "neutral",
      glyph: "issue",
    });
  });

  it("maps pull request states, drafts and checks", () => {
    expect(presentForgeLinkChip(pr, summary({ checksStatus: "pending" }))).toMatchObject({
      tone: "open",
      glyph: "pull_request",
      checks: "pending",
    });
    expect(presentForgeLinkChip(pr, summary({ draft: true }))).toMatchObject({ tone: "draft" });
    expect(presentForgeLinkChip(pr, summary({ state: "merged" }))).toMatchObject({
      tone: "merged",
      checks: null,
    });
    expect(presentForgeLinkChip(pr, summary({ state: "closed" }))).toMatchObject({
      tone: "closed",
      glyph: "pull_request_closed",
    });
  });

  it("maps issues and truncates long titles", () => {
    const closed = presentForgeLinkChip(
      issue,
      summary({ kind: "issue", state: "closed", title: "x".repeat(80) }),
    );
    expect(closed).toMatchObject({ tone: "merged", glyph: "issue_closed" });
    expect(closed.title?.length).toBe(48);
    expect(closed.title?.endsWith("…")).toBe(true);
  });
});
