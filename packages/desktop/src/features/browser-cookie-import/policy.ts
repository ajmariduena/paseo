// Adapted from stablyai/orca (MIT).
import { isIP } from "node:net";
import { parse as parseDomain } from "tldts";

export type SameSite = "unspecified" | "no_restriction" | "lax" | "strict";
export type Partition =
  | { status: "unpartitioned" }
  | { status: "partitioned"; partitionKey: { topLevelSite: string; hasCrossSiteAncestor: boolean } }
  | { status: "unreadable" };
export interface SourceCookie {
  domain: string;
  hostOnly?: boolean;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  expirationDate?: number;
  partition: Partition;
}
export type CookieIdentity = SourceCookie & {
  url: string;
  hostOnly: boolean;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
};
const PUBLIC_SUFFIX_OPTIONS = { allowPrivateDomains: true } as const;

export function normalizeDomain(raw: string): string | null {
  const candidate = raw.trim().replace(/^\.+/, "");
  if (
    !candidate ||
    /[/\\@?#%]/.test(candidate) ||
    candidate.includes("\0") ||
    (candidate.includes(":") && !candidate.startsWith("["))
  )
    return null;
  try {
    const url = new URL("https://" + candidate + "/");
    const host = url.hostname.toLowerCase();
    if (
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      host.endsWith(".") ||
      host.includes("..")
    )
      return null;
    return host;
  } catch {
    return null;
  }
}

// Null for a bare public suffix: naming `com` as a family would make an import replace a whole TLD.
export function registrableFamily(raw: string): string | null {
  const host = normalizeDomain(raw);
  if (!host) return null;
  if (isIP(host) || (host.startsWith("[") && isIP(host.slice(1, -1)))) return host;
  const parsed = parseDomain(host, PUBLIC_SUFFIX_OPTIONS);
  if (parsed.hostname === null) return host;
  if (parsed.domain === null) return parsed.isIcann || parsed.isPrivate ? null : host;
  return parsed.domain;
}
export function importableDomain(raw: string): string | null {
  const host = normalizeDomain(raw);
  return host && registrableFamily(host) ? host : null;
}
// google.com sessions are device-bound server-side, so a copied cookie is rejected; the user has to
// sign in inside Paseo. youtube.com accepts a copied session and stays importable.
export function isGoogle(raw: string): boolean {
  const host = normalizeDomain(raw);
  return host === "google.com" || host?.endsWith(".google.com") === true;
}
export function databaseSameSite(raw: unknown): SameSite {
  if (raw === 0 || raw === 0n) return "no_restriction";
  if (raw === 1 || raw === 1n) return "lax";
  if (raw === 2 || raw === 2n) return "strict";
  return "unspecified";
}
export function sameSite(raw: unknown): SameSite {
  if (typeof raw === "number") return databaseSameSite(raw);
  if (typeof raw !== "string") return "unspecified";
  const value = raw.toLowerCase();
  if (value === "none" || value === "no_restriction") return "no_restriction";
  if (value === "lax" || value === "strict") return value;
  return "unspecified";
}
function partitionSite(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
export function jsonPartition(raw: unknown, opaque?: unknown): Partition {
  if (opaque === true || (opaque !== undefined && typeof opaque !== "boolean"))
    return { status: "unreadable" };
  if (raw === undefined) return { status: "unpartitioned" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "unreadable" };
  const entry = raw as Record<string, unknown>;
  const topLevelSite = partitionSite(entry.topLevelSite);
  if (!topLevelSite || typeof entry.hasCrossSiteAncestor !== "boolean")
    return { status: "unreadable" };
  return {
    status: "partitioned",
    partitionKey: { topLevelSite, hasCrossSiteAncestor: entry.hasCrossSiteAncestor },
  };
}
export function chromiumPartition(
  row: Record<string, unknown>,
  columns: ReadonlySet<string>,
): Partition {
  if (!columns.has("top_frame_site_key")) return { status: "unpartitioned" };
  if (row.top_frame_site_key === "") return { status: "unpartitioned" };
  const topLevelSite = partitionSite(row.top_frame_site_key);
  const ancestor = row.has_cross_site_ancestor;
  if (
    !topLevelSite ||
    !columns.has("has_cross_site_ancestor") ||
    !(ancestor === 0 || ancestor === 1 || ancestor === 0n || ancestor === 1n)
  )
    return { status: "unreadable" };
  return {
    status: "partitioned",
    partitionKey: { topLevelSite, hasCrossSiteAncestor: ancestor === 1 || ancestor === 1n },
  };
}
export function firefoxPartition(
  row: Record<string, unknown>,
  columns: ReadonlySet<string>,
): Partition {
  if (
    !columns.has("isPartitionedAttributeSet") ||
    row.isPartitionedAttributeSet === 0 ||
    row.isPartitionedAttributeSet === 0n
  )
    return { status: "unpartitioned" };
  return { status: "unreadable" };
}
export function parseJsonCookies(text: string): { cookies: SourceCookie[]; total: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const cookies: SourceCookie[] = [];
  for (const item of parsed) {
    const cookie = parseJsonCookieEntry(item);
    if (cookie) cookies.push(cookie);
  }
  return { cookies, total: parsed.length };
}
function parseJsonCookieEntry(item: unknown): SourceCookie | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  if (
    typeof row.domain !== "string" ||
    typeof row.name !== "string" ||
    !row.name.trim() ||
    typeof row.value !== "string"
  )
    return null;
  const domain = row.domain.trim();
  if (!importableDomain(domain)) return null;
  if (row.hostOnly !== undefined && typeof row.hostOnly !== "boolean") return null;
  const expirationDate =
    typeof row.expirationDate === "number" &&
    Number.isFinite(row.expirationDate) &&
    row.expirationDate > 0
      ? row.expirationDate
      : undefined;
  return {
    domain,
    ...(typeof row.hostOnly === "boolean" ? { hostOnly: row.hostOnly } : {}),
    name: row.name.trim(),
    value: row.value,
    path: typeof row.path === "string" && row.path.startsWith("/") ? row.path : "/",
    secure: row.secure === true || row.secure === 1,
    httpOnly: row.httpOnly === true || row.httpOnly === 1,
    sameSite: sameSite(row.sameSite),
    expirationDate,
    partition: jsonPartition(row.partitionKey, row.partitionKeyOpaque),
  };
}
function hasInvalidWriteFields(cookie: SourceCookie, now: number): boolean {
  return (
    !cookie.name ||
    (cookie.expirationDate !== undefined && cookie.expirationDate <= now) ||
    !cookie.path.startsWith("/") ||
    (cookie.name.startsWith("__Host-") &&
      (!cookie.secure ||
        cookie.path !== "/" ||
        !(cookie.hostOnly ?? !cookie.domain.startsWith(".")))) ||
    (cookie.name.startsWith("__Secure-") && !cookie.secure)
  );
}
export function planCookies(input: readonly SourceCookie[]): {
  writes: CookieIdentity[];
  skipped: number;
  googleSkipped: number;
  partitionSkipped: number;
} {
  const now = Date.now() / 1000;
  const suppressed = new Set<string>();
  for (const cookie of input) {
    if (cookie.partition.status === "unreadable") {
      const family = registrableFamily(cookie.domain);
      if (!family) throw new Error("unrepresentable_partition");
      suppressed.add(family);
    }
  }
  const writes: CookieIdentity[] = [];
  let skipped = 0,
    googleSkipped = 0,
    partitionSkipped = 0;
  for (const cookie of input) {
    const domain = importableDomain(cookie.domain);
    if (!domain || hasInvalidWriteFields(cookie, now)) {
      skipped++;
      continue;
    }
    if (isGoogle(domain)) {
      skipped++;
      googleSkipped++;
      continue;
    }
    if (suppressed.has(registrableFamily(domain)!)) {
      skipped++;
      partitionSkipped++;
      continue;
    }
    const hostOnly = cookie.hostOnly ?? !cookie.domain.startsWith(".");
    writes.push({
      ...cookie,
      domain,
      hostOnly,
      path: cookie.name.startsWith("__Host-") ? "/" : cookie.path,
      url: (cookie.secure ? "https://" : "http://") + domain + "/",
      ...(cookie.partition.status === "partitioned"
        ? { partitionKey: cookie.partition.partitionKey }
        : {}),
    });
  }
  return { writes, skipped, googleSkipped, partitionSkipped };
}
export function createRemovalScope(
  writes: readonly CookieIdentity[],
): (existing: { domain: string; hostOnly: boolean }) => boolean {
  const familyByDomain = new Map<string, string | null>();
  for (const write of writes) {
    if (!familyByDomain.has(write.domain)) {
      familyByDomain.set(write.domain, registrableFamily(write.domain));
    }
  }
  return (existing) => {
    const host = normalizeDomain(existing.domain);
    if (!host || isGoogle(host)) return false;
    if (familyByDomain.has(host)) return true;
    const family = registrableFamily(host);
    if (!family) return false;
    for (let dot = host.indexOf("."); dot >= 0; dot = host.indexOf(".", dot + 1)) {
      const ancestor = host.slice(dot + 1);
      if (familyByDomain.get(ancestor) === family) return true;
    }
    if (existing.hostOnly) return false;
    for (const [domain, domainFamily] of familyByDomain) {
      if (domainFamily === family && domain.endsWith("." + host)) return true;
    }
    return false;
  };
}

export function inRemovalScope(
  existing: { domain: string; hostOnly: boolean },
  writes: readonly CookieIdentity[],
): boolean {
  return createRemovalScope(writes)(existing);
}
