import type { VoiceFleetDigest, VoiceFleetHostState } from "@getpaseo/protocol/voice-fleet/types";

/** A paired host other than the one running the call, as the phone sees it now. */
export interface FleetHost {
  serverId: string;
  label: string;
  isConnected: boolean;
  supportsFleet: boolean;
}

export interface RememberedFleetHost {
  digest: VoiceFleetDigest | null;
  lastSeenAt: string;
}

export function selectDigestHosts(hosts: FleetHost[]): FleetHost[] {
  return hosts.filter((host) => host.isConnected && host.supportsFleet);
}

/**
 * Connected hosts are seen now and take their fresh digest; a failed fetch or an offline host
 * keeps the last one, so the call can still say what a host was doing when it went quiet.
 */
export function rememberFleetHosts(input: {
  previous: ReadonlyMap<string, RememberedFleetHost>;
  hosts: FleetHost[];
  digests: ReadonlyMap<string, VoiceFleetDigest>;
  now: string;
}): Map<string, RememberedFleetHost> {
  const next = new Map(input.previous);
  for (const host of input.hosts) {
    if (!host.isConnected) continue;
    const digest = input.digests.get(host.serverId) ?? input.previous.get(host.serverId)?.digest;
    next.set(host.serverId, { digest: digest ?? null, lastSeenAt: input.now });
  }
  return next;
}

export function buildFleetHostStates(input: {
  hosts: FleetHost[];
  remembered: ReadonlyMap<string, RememberedFleetHost>;
}): VoiceFleetHostState[] {
  return input.hosts.map((host) => {
    const remembered = input.remembered.get(host.serverId);
    return {
      serverId: host.serverId,
      label: host.label,
      online: host.isConnected,
      lastSeenAt: remembered?.lastSeenAt ?? null,
      supportsTools: host.supportsFleet,
      digest: remembered?.digest ?? null,
    };
  });
}

export interface OperationDedupe {
  /** True the first time an operation is seen; later pushes of it are ignored. */
  claim: (operationId: string) => boolean;
}

export function createOperationDedupe(limit: number): OperationDedupe {
  const seen = new Set<string>();
  return {
    claim(operationId) {
      if (seen.has(operationId)) return false;
      seen.add(operationId);
      if (seen.size > limit) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
  };
}

export interface FleetSyncLoop {
  start: () => void;
  /** Runs within `soonMs`, unless a run is already due sooner. */
  requestSoon: () => void;
  stop: () => void;
}

/**
 * One timer drives every run: the next one is due `intervalMs` after the last finished, or
 * sooner when something changed. Runs never overlap; a run that comes due mid-flight starts
 * right after the current one.
 */
export function createFleetSyncLoop(params: {
  run: () => Promise<void>;
  intervalMs: number;
  soonMs: number;
}): FleetSyncLoop {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = Number.POSITIVE_INFINITY;
  let isRunning = false;
  let isRunPending = false;
  let isStopped = true;

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    dueAt = Number.POSITIVE_INFINITY;
  }

  function schedule(delayMs: number): void {
    if (isStopped) return;
    const at = Date.now() + delayMs;
    if (timer && dueAt <= at) return;
    clearTimer();
    dueAt = at;
    timer = setTimeout(runNow, delayMs);
  }

  function runNow(): void {
    clearTimer();
    if (isRunning) {
      isRunPending = true;
      return;
    }
    isRunning = true;
    void params
      .run()
      .catch(() => undefined)
      .finally(() => {
        isRunning = false;
        if (isStopped) return;
        if (isRunPending) {
          isRunPending = false;
          runNow();
          return;
        }
        schedule(params.intervalMs);
      });
  }

  return {
    start() {
      if (!isStopped) return;
      isStopped = false;
      runNow();
    },
    requestSoon() {
      schedule(params.soonMs);
    },
    stop() {
      isStopped = true;
      isRunPending = false;
      clearTimer();
    },
  };
}
