import { describe, expect, it } from "vitest";
import { parseForgeLink } from "./forge-link-ref";

describe("parseForgeLink", () => {
  it("parses pull request and issue links on github.com", () => {
    expect(parseForgeLink("https://github.com/getpaseo/paseo/pull/5727/files#diff")).toEqual({
      host: "github.com",
      owner: "getpaseo",
      repo: "paseo",
      number: 5727,
      kind: "pull_request",
      key: "github.com/getpaseo/paseo#5727",
    });
    expect(parseForgeLink("https://www.github.com/GetPaseo/Paseo/issues/12")).toMatchObject({
      kind: "issue",
      number: 12,
      key: "github.com/getpaseo/paseo#12",
    });
  });

  it("ignores other forges, other GitHub pages and partial URLs", () => {
    expect(parseForgeLink("https://gitlab.com/a/b/-/merge_requests/3")).toBeNull();
    expect(parseForgeLink("https://github.example.com/a/b/pull/3")).toBeNull();
    expect(parseForgeLink("https://github.com/getpaseo/paseo/blob/main/docs/a.md")).toBeNull();
    expect(parseForgeLink("https://github.com/getpaseo/paseo/pull/")).toBeNull();
    expect(parseForgeLink("https://github.com/getpaseo/paseo/pull/0")).toBeNull();
  });
});
