import { describe, expect, it } from "vitest";
import {
  databaseSameSite,
  inRemovalScope,
  parseJsonCookies,
  planCookies,
  registrableFamily,
  type SourceCookie,
} from "./policy.js";
import { parseRequest } from "./types.js";

function cookie(domain: string, overrides: Partial<SourceCookie> = {}): SourceCookie {
  return {
    domain,
    name: "session",
    value: "token",
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "unspecified",
    partition: { status: "unpartitioned" },
    ...overrides,
  };
}
describe("cookie policy", () => {
  it("maps SameSite without forcing Secure, preserves host-only, and enforces __Host-", () => {
    expect([0, 1, 2, 256, null].map(databaseSameSite)).toEqual([
      "no_restriction",
      "lax",
      "strict",
      "unspecified",
      "unspecified",
    ]);
    const plan = planCookies([
      cookie("example.com", { sameSite: "no_restriction" }),
      cookie(".example.com", { name: "domain", secure: true }),
      cookie("example.com", { name: "__Host-session", secure: true }),
      cookie(".example.com", { name: "__Host-invalid", secure: true }),
    ]);
    expect(
      plan.writes.map(({ name, hostOnly, secure, path, sameSite }) => ({
        name,
        hostOnly,
        secure,
        path,
        sameSite,
      })),
    ).toEqual([
      { name: "session", hostOnly: true, secure: false, path: "/", sameSite: "no_restriction" },
      { name: "domain", hostOnly: false, secure: true, path: "/", sameSite: "unspecified" },
      { name: "__Host-session", hostOnly: true, secure: true, path: "/", sameSite: "unspecified" },
    ]);
    expect(plan.skipped).toBe(1);
  });
  it("excludes exact google.com family while keeping lookalikes and YouTube", () => {
    const plan = planCookies([
      cookie("google.com"),
      cookie("accounts.google.com"),
      cookie("notgoogle.com"),
      cookie("youtube.com"),
    ]);
    expect(plan.googleSkipped).toBe(2);
    expect(plan.writes.map((entry) => entry.domain)).toEqual(["notgoogle.com", "youtube.com"]);
    expect(inRemovalScope({ domain: ".google.com", hostOnly: false }, plan.writes)).toBe(false);
  });
  it("replaces exact, covering parent and descendant cookies without touching siblings or other sites", () => {
    const writes = planCookies([cookie("foo.example.com")]).writes;
    expect(
      ["foo.example.com", "bar.foo.example.com", ".example.com"].map((domain) =>
        inRemovalScope({ domain, hostOnly: !domain.startsWith(".") }, writes),
      ),
    ).toEqual([true, true, true]);
    expect(
      ["example.com", "bar.example.com", "other.com"].map((domain) =>
        inRemovalScope({ domain, hostOnly: true }, writes),
      ),
    ).toEqual([false, false, false]);
  });
  it("isolates private public suffix tenants", () => {
    expect(registrableFamily("alice.github.io")).toBe("alice.github.io");
    expect(registrableFamily("bob.github.io")).toBe("bob.github.io");
    const writes = planCookies([cookie("alice.github.io")]).writes;
    expect(inRemovalScope({ domain: ".bob.github.io", hostOnly: false }, writes)).toBe(false);
    expect(inRemovalScope({ domain: ".github.io", hostOnly: false }, writes)).toBe(false);
  });
  it("suppresses a whole registrable family when one partition identity is unreadable", () => {
    const plan = planCookies([
      cookie("example.com"),
      cookie("sub.example.com", { partition: { status: "unreadable" } }),
      cookie("other.com"),
    ]);
    expect(plan.writes.map((entry) => entry.domain)).toEqual(["other.com"]);
    expect(plan.partitionSkipped).toBe(2);
  });
  it("parses JSON arrays and rejects traversal profile ids", () => {
    const parsed = parseJsonCookies(
      JSON.stringify([
        {
          domain: "example.com",
          name: "a",
          value: "b",
          partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false },
        },
        { domain: ".example.com", hostOnly: true, name: "ordinary", value: "value" },
        { bad: true },
      ]),
    );
    expect(parsed?.total).toBe(3);
    expect(parsed?.cookies[0].partition).toEqual({
      status: "partitioned",
      partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false },
    });
    expect(planCookies(parsed?.cookies ?? []).writes[1].hostOnly).toBe(true);
    expect(parseJsonCookies("{}")).toBeNull();
    expect(parseJsonCookies("oops")).toBeNull();
    for (const profileId of ["../Default", "foo/bar", "foo\\bar", "a..b", "a\0b"]) {
      expect(parseRequest({ kind: "browser", family: "chrome", profileId })).toBeNull();
    }
    expect(parseRequest({ kind: "browser", family: "chrome", profileId: "Profile 1" })).toEqual({
      kind: "browser",
      family: "chrome",
      profileId: "Profile 1",
    });
  });
});
