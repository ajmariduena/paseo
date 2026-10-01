// Adapted from stablyai/orca (MIT).
import type { BrowserWindow, Session, WebContents } from "electron";
import {
  createRemovalScope,
  jsonPartition,
  normalizeDomain,
  type CookieIdentity,
} from "./policy.js";

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session?: boolean;
  expires?: number;
  sameSite?: string;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
  partitionKeyOpaque?: boolean;
}
export interface CookieAdapter {
  get(): Promise<CdpCookie[]>;
  set(identity: CookieIdentity): Promise<void>;
  remove(identity: CookieIdentity): Promise<void>;
  close(): void;
}
function urlFor(cookie: { domain: string; path: string; secure: boolean }): string {
  const domain = normalizeDomain(cookie.domain);
  if (!domain) throw new Error("invalid_cookie_domain");
  const url = new URL((cookie.secure ? "https://" : "http://") + domain + "/");
  url.pathname = cookie.path.startsWith("/") ? cookie.path : "/";
  return url.toString();
}
function fromCdp(cookie: CdpCookie): CookieIdentity {
  const partition = jsonPartition(cookie.partitionKey, cookie.partitionKeyOpaque);
  if (partition.status === "unreadable") throw new Error("incomplete_partition");
  const domain = normalizeDomain(cookie.domain);
  if (!domain) throw new Error("invalid_cookie_domain");
  return {
    domain,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: !cookie.domain.startsWith("."),
    sameSite: fromCdpSameSite(cookie.sameSite),
    ...(cookie.session || cookie.expires === undefined || cookie.expires <= 0
      ? {}
      : { expirationDate: cookie.expires }),
    partition,
    ...(partition.status === "partitioned" ? { partitionKey: partition.partitionKey } : {}),
    url: urlFor(cookie),
  };
}
function fromCdpSameSite(value: string | undefined): CookieIdentity["sameSite"] {
  if (value === "Strict") return "strict";
  if (value === "Lax") return "lax";
  if (value === "None") return "no_restriction";
  return "unspecified";
}
function toCdpSameSite(value: CookieIdentity["sameSite"]): "Strict" | "Lax" | "None" | undefined {
  if (value === "strict") return "Strict";
  if (value === "lax") return "Lax";
  if (value === "no_restriction") return "None";
  return undefined;
}
function params(identity: CookieIdentity): Record<string, unknown> {
  return {
    url: identity.url,
    name: identity.name,
    value: identity.value,
    ...(identity.hostOnly ? {} : { domain: "." + identity.domain }),
    path: identity.path,
    secure: identity.secure,
    httpOnly: identity.httpOnly,
    ...(toCdpSameSite(identity.sameSite) ? { sameSite: toCdpSameSite(identity.sameSite) } : {}),
    ...(identity.expirationDate === undefined ? {} : { expires: identity.expirationDate }),
    ...(identity.partitionKey ? { partitionKey: identity.partitionKey } : {}),
  };
}
interface HiddenLease {
  contents: WebContents;
  window: BrowserWindow;
  users: number;
}
const pendingWindows = new WeakMap<Session, Promise<HiddenLease>>();
const liveWindows = new WeakMap<Session, HiddenLease>();
async function hidden(session: Session): Promise<HiddenLease> {
  const live = liveWindows.get(session);
  if (live && !live.window.isDestroyed()) {
    live.users++;
    return live;
  }
  const existing = pendingWindows.get(session);
  if (existing) {
    const lease = await existing;
    lease.users++;
    return lease;
  }
  const acquisition = (async () => {
    const { BrowserWindow } = await import("electron");
    const window = new BrowserWindow({
      show: false,
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await window.loadURL("about:blank");
      window.webContents.debugger.attach("1.3");
      const lease: HiddenLease = { contents: window.webContents, window, users: 0 };
      liveWindows.set(session, lease);
      return lease;
    } catch (error) {
      window.destroy();
      throw error;
    }
  })();
  pendingWindows.set(session, acquisition);
  try {
    const lease = await acquisition;
    lease.users++;
    return lease;
  } finally {
    if (pendingWindows.get(session) === acquisition) pendingWindows.delete(session);
  }
}
function releaseHidden(session: Session, lease: HiddenLease): void {
  lease.users--;
  if (lease.users > 0) return;
  liveWindows.delete(session);
  if (lease.contents.debugger.isAttached()) lease.contents.debugger.detach();
  lease.window.destroy();
}
// A hidden window keeps the debugger off the user's tabs, where browser automation attaches its own.
export async function openCookieAdapter(session: Session): Promise<CookieAdapter> {
  const lease = await hidden(session);
  const contents = lease.contents;
  const debuggerClient = contents.debugger;
  return {
    get: async () => {
      const result = (await debuggerClient.sendCommand("Network.getAllCookies")) as {
        cookies?: CdpCookie[];
      };
      if (!Array.isArray(result.cookies)) throw new Error("cookie_snapshot_failed");
      return result.cookies;
    },
    set: async (identity) => {
      const result = (await debuggerClient.sendCommand("Network.setCookie", params(identity))) as {
        success?: boolean;
      };
      if (result.success === false) throw new Error("cookie_write_rejected");
    },
    remove: async (identity) => {
      await debuggerClient.sendCommand("Network.deleteCookies", {
        name: identity.name,
        url: identity.url,
        ...(identity.hostOnly ? {} : { domain: "." + identity.domain }),
        path: identity.path,
        ...(identity.partitionKey ? { partitionKey: identity.partitionKey } : {}),
      });
    },
    close: () => releaseHidden(session, lease),
  };
}
function identityKey(cookie: CookieIdentity): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.hostOnly,
    cookie.path,
    cookie.partitionKey ?? null,
  ]);
}
async function restore(
  adapter: CookieAdapter,
  removed: readonly CookieIdentity[],
  written: readonly CookieIdentity[],
): Promise<void> {
  const failures: unknown[] = [];
  for (let i = written.length - 1; i >= 0; i--)
    try {
      await adapter.remove(written[i]);
    } catch (error) {
      failures.push(error);
    }
  for (let i = removed.length - 1; i >= 0; i--)
    try {
      await adapter.set(removed[i]);
    } catch (error) {
      failures.push(error);
    }
  if (failures.length) throw new AggregateError(failures, "cookie_rollback_failed");
}
// A rejected write must not leave the user signed out of the cookie it was replacing.
async function restoreReplaced(
  adapter: CookieAdapter,
  previous: CookieIdentity | undefined,
): Promise<void> {
  if (!previous) return;
  try {
    await adapter.set(previous);
  } catch {
    /* Counted as failed already; nothing else to restore. */
  }
}
export async function replaceCookies(
  adapter: CookieAdapter,
  writes: readonly CookieIdentity[],
  rollbackOnFailure: boolean,
): Promise<{ imported: number; failed: number; domainCount: number }> {
  if (!writes.length) return { imported: 0, failed: 0, domainCount: 0 };
  const snapshot = await adapter.get();
  const inScope = createRemovalScope(writes);
  const removable: CookieIdentity[] = [];
  const seen = new Set<string>();
  for (const cookie of snapshot) {
    if (!inScope({ domain: cookie.domain, hostOnly: !cookie.domain.startsWith(".") })) continue;
    const identity = fromCdp(cookie);
    const key = identityKey(identity);
    if (!seen.has(key)) {
      seen.add(key);
      removable.push(identity);
    }
  }
  const removed: CookieIdentity[] = [];
  const written: CookieIdentity[] = [];
  const attempted: CookieIdentity[] = [];
  try {
    for (const identity of removable) {
      removed.push(identity);
      await adapter.remove(identity);
    }
    const removedByKey = new Map(removed.map((identity) => [identityKey(identity), identity]));
    let failed = 0;
    for (const identity of writes) {
      attempted.push(identity);
      try {
        await adapter.set(identity);
        written.push(identity);
      } catch (error) {
        if (rollbackOnFailure) throw error;
        failed++;
        await restoreReplaced(adapter, removedByKey.get(identityKey(identity)));
      }
    }
    return {
      imported: written.length,
      failed,
      domainCount: new Set(written.map((cookie) => cookie.domain)).size,
    };
  } catch (error) {
    try {
      await restore(adapter, removed, attempted);
    } catch (rollbackError) {
      throw new Error("cookie_replacement_and_rollback_failed", { cause: rollbackError });
    }
    throw error;
  }
}
