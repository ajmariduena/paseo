import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ForgeLinkRef, ForgeLinkSummary } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { ParsedForgeLink } from "./forge-link-ref";

const FLUSH_DELAY_MS = 60;
const REQUEST_MAX_REFS = 50;
const FAILED_RETRY_MS = 60_000;

export interface ForgeLinkSummaryClient {
  getForgeLinkSummaries(params: { refs: ForgeLinkRef[] }): Promise<ForgeLinkSummary[]>;
}

interface Entry {
  summary: ForgeLinkSummary | null;
  fetchedAt: number;
  inFlight: boolean;
}

interface PendingBatch {
  client: ForgeLinkSummaryClient;
  refs: Map<string, ParsedForgeLink>;
  timer: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const pending = new Map<string, PendingBatch>();

function entryKey(serverId: string, linkKey: string): string {
  return `${serverId}|${linkKey}`;
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function freshnessMs(summary: ForgeLinkSummary | null): number {
  if (!summary) return FAILED_RETRY_MS;
  if (!summary.available) return 10 * 60_000;
  if (summary.state !== "open") return 60 * 60_000;
  return summary.checksStatus === "pending" ? 30_000 : 2 * 60_000;
}

function isFresh(entry: Entry | undefined, now: number): boolean {
  if (!entry) return false;
  return entry.inFlight || now - entry.fetchedAt < freshnessMs(entry.summary);
}

function settle(serverId: string, refs: ParsedForgeLink[], summaries: ForgeLinkSummary[]): void {
  const now = Date.now();
  const byKey = new Map(
    summaries.map((summary) => [
      `${summary.host}/${summary.owner.toLowerCase()}/${summary.repo.toLowerCase()}#${summary.number}`,
      summary,
    ]),
  );
  for (const ref of refs) {
    const key = entryKey(serverId, ref.key);
    const previous = entries.get(key);
    entries.set(key, {
      summary: byKey.get(ref.key) ?? previous?.summary ?? null,
      fetchedAt: now,
      inFlight: false,
    });
    notify(key);
  }
}

function flush(serverId: string): void {
  const batch = pending.get(serverId);
  pending.delete(serverId);
  if (!batch) return;
  const refs = [...batch.refs.values()];
  for (let start = 0; start < refs.length; start += REQUEST_MAX_REFS) {
    const chunk = refs.slice(start, start + REQUEST_MAX_REFS);
    batch.client
      .getForgeLinkSummaries({
        refs: chunk.map(({ host, owner, repo, number }) => ({ host, owner, repo, number })),
      })
      .then(
        (summaries) => settle(serverId, chunk, summaries),
        () => settle(serverId, chunk, []),
      );
  }
}

export function requestForgeLinkSummary(input: {
  serverId: string;
  link: ParsedForgeLink;
  client: ForgeLinkSummaryClient;
  now?: number;
}): void {
  const key = entryKey(input.serverId, input.link.key);
  const existing = entries.get(key);
  if (isFresh(existing, input.now ?? Date.now())) return;
  entries.set(key, {
    summary: existing?.summary ?? null,
    fetchedAt: existing?.fetchedAt ?? 0,
    inFlight: true,
  });

  const batch = pending.get(input.serverId);
  if (batch) {
    batch.refs.set(input.link.key, input.link);
    return;
  }
  pending.set(input.serverId, {
    client: input.client,
    refs: new Map([[input.link.key, input.link]]),
    timer: setTimeout(() => flush(input.serverId), FLUSH_DELAY_MS),
  });
}

export function getForgeLinkSummary(serverId: string, linkKey: string): ForgeLinkSummary | null {
  return entries.get(entryKey(serverId, linkKey))?.summary ?? null;
}

export function resetForgeLinkSummariesForTest(): void {
  for (const batch of pending.values()) clearTimeout(batch.timer);
  pending.clear();
  entries.clear();
  listeners.clear();
}

export function useForgeLinkSummary(input: {
  serverId: string | null;
  link: ParsedForgeLink;
  enabled: boolean;
}): ForgeLinkSummary | null {
  const { serverId, link, enabled } = input;
  const key = serverId ? entryKey(serverId, link.key) : null;
  const supported = useSessionStore(
    useCallback(
      (state) =>
        serverId !== null &&
        state.sessions[serverId]?.serverInfo?.features?.forgeLinkSummaries === true,
      [serverId],
    ),
  );

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {};
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => (key ? (entries.get(key)?.summary ?? null) : null), [key]);
  const summary = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled || !supported || !serverId) return;
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) return;
    requestForgeLinkSummary({ serverId, link, client });
  }, [enabled, supported, serverId, link]);

  return summary;
}
