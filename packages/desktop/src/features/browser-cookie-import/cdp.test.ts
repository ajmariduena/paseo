import { expect, it } from "vitest";
import { replaceCookies, type CdpCookie, type CookieAdapter } from "./cdp.js";
import { planCookies, type CookieIdentity, type SourceCookie } from "./policy.js";

function cookie(
  domain: string,
  name: string,
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean },
): SourceCookie {
  return {
    domain,
    name,
    value: name + "-value",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    partition: partitionKey ? { status: "partitioned", partitionKey } : { status: "unpartitioned" },
  };
}
function cdp(identity: CookieIdentity): CdpCookie {
  return {
    name: identity.name,
    value: identity.value,
    domain: identity.hostOnly ? identity.domain : "." + identity.domain,
    path: identity.path,
    secure: identity.secure,
    httpOnly: identity.httpOnly,
    sameSite: "Lax",
    ...(identity.partitionKey ? { partitionKey: identity.partitionKey } : {}),
  };
}
function adapter(initial: CookieIdentity[], failName?: string) {
  const jar = initial.map(cdp);
  const removed: string[] = [];
  const port: CookieAdapter = {
    get: async () => [...jar],
    set: async (identity) => {
      if (identity.name === failName) throw new Error("rejected");
      jar.push(cdp(identity));
    },
    remove: async (identity) => {
      removed.push(identity.name);
      const index = jar.findIndex(
        (item) =>
          item.name === identity.name &&
          item.domain.replace(/^\./, "") === identity.domain &&
          JSON.stringify(item.partitionKey ?? null) ===
            JSON.stringify(identity.partitionKey ?? null),
      );
      if (index >= 0) jar.splice(index, 1);
    },
    close: () => {},
  };
  return { port, jar, removed };
}
it("replaces only planned scope and keeps unrelated, sibling and Google sessions", async () => {
  const existing = planCookies([
    cookie("foo.example.com", "old"),
    cookie("other.com", "other"),
    cookie("bar.example.com", "sibling"),
  ]).writes;
  const fake = adapter(existing);
  fake.jar.push({
    name: "google",
    value: "live",
    domain: ".google.com",
    path: "/",
    secure: true,
    httpOnly: true,
  });
  const result = await replaceCookies(
    fake.port,
    planCookies([cookie("foo.example.com", "fresh"), cookie("accounts.google.com", "skipped")])
      .writes,
    false,
  );
  expect(result).toEqual({ imported: 1, failed: 0, domainCount: 1 });
  expect(fake.removed).toEqual(["old"]);
  expect(fake.jar.map((item) => item.name).sort()).toEqual(["fresh", "google", "other", "sibling"]);
});
it("rolls back prior writes and restores partitioned identities after a rejected file write", async () => {
  const partitionKey = { topLevelSite: "https://other.com", hasCrossSiteAncestor: false };
  const existing = planCookies([
    cookie("example.com", "old", partitionKey),
    cookie("example.com", "old"),
  ]).writes;
  const fake = adapter(existing, "reject");
  const incoming = planCookies([
    cookie("example.com", "first"),
    cookie("example.com", "reject"),
  ]).writes;
  await expect(replaceCookies(fake.port, incoming, true)).rejects.toThrow("rejected");
  expect(
    fake.jar.map((entry) => ({ name: entry.name, partitionKey: entry.partitionKey ?? null })),
  ).toEqual([
    { name: "old", partitionKey: null },
    { name: "old", partitionKey },
  ]);
  expect(fake.removed).toContain("first");
});
it("does not touch a cookie added after the removal snapshot", async () => {
  const old = planCookies([cookie("example.com", "old")]).writes[0];
  const fresh = planCookies([cookie("example.com", "fresh")]).writes[0];
  const fake = adapter([old]);
  const originalRemove = fake.port.remove;
  let inserted = false;
  fake.port.remove = async (identity) => {
    if (!inserted) {
      inserted = true;
      fake.jar.push(cdp(planCookies([cookie("example.com", "late")]).writes[0]));
    }
    await originalRemove(identity);
  };
  await replaceCookies(fake.port, [fresh], false);
  expect(fake.jar.map((entry) => entry.name).sort()).toEqual(["fresh", "late"]);
});
it("restores the replaced cookie when a Chromium write is rejected", async () => {
  const [existing] = planCookies([cookie("example.com", "session")]).writes;
  const jar: CdpCookie[] = [cdp(existing)];
  const port: CookieAdapter = {
    get: async () => [...jar],
    set: async (identity) => {
      if (identity.value === "rejected-value") throw new Error("rejected");
      jar.push(cdp(identity));
    },
    remove: async (identity) => {
      const index = jar.findIndex((item) => item.name === identity.name);
      if (index >= 0) jar.splice(index, 1);
    },
    close: () => {},
  };
  const [incoming] = planCookies([
    { ...cookie("example.com", "session"), value: "rejected-value" },
  ]).writes;

  const result = await replaceCookies(port, [incoming], false);

  expect(result).toEqual({ imported: 0, failed: 1, domainCount: 0 });
  expect(jar.map((item) => item.value)).toEqual(["session-value"]);
});
