import type pino from "pino";
import type { VoiceFleetHostState, VoiceToolResult } from "@getpaseo/protocol/voice-fleet/types";
import type { FleetHost } from "./fleet-view.js";

export interface CourierRequest {
  operationId: string;
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  language: string | null;
}

/** The phone's channel back from this host: pushes an action for it to run elsewhere. */
export type CourierChannel = (request: CourierRequest) => void;

// The phone checks in every few seconds during a call; past this its view is not live.
const SYNC_STALE_MS = 20_000;
// A remote action runs over two phone hops; past this the user hears it wasn't confirmed.
// Creations get longer: a worktree with setup scripts can take most of a minute.
const COURIER_TIMEOUT_MS = 16_000;
const COURIER_CREATION_TIMEOUT_MS = 60_000;
const SLOW_TOOLS = new Set(["start_agent", "create_workspace", "archive_workspace"]);

export class CourierTimeoutError extends Error {
  constructor(readonly hostLabel: string) {
    super(`no answer from ${hostLabel} through the phone`);
    this.name = "CourierTimeoutError";
  }
}

/**
 * The other hosts as the phone last reported them, and the courier that carries actions to
 * them. Hosts never talk to each other; the phone is the only link.
 */
export class RemoteFleet {
  private hosts: VoiceFleetHostState[] = [];
  private syncedAt = 0;
  private appState: string | null = null;
  private channel: CourierChannel | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: VoiceToolResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly options: {
      logger: pino.Logger;
      now?: () => number;
      onChange?: () => void;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  update(params: {
    hosts: VoiceFleetHostState[];
    appState: string | null;
    channel: CourierChannel | null;
  }): void {
    const changed =
      JSON.stringify(stripTimes(params.hosts)) !== JSON.stringify(stripTimes(this.hosts));
    this.hosts = params.hosts;
    this.syncedAt = this.now();
    this.appState = params.appState;
    if (params.channel) this.channel = params.channel;
    if (changed) this.options.onChange?.();
  }

  get isLive(): boolean {
    return this.syncedAt > 0 && this.now() - this.syncedAt < SYNC_STALE_MS;
  }

  get phoneAppState(): string | null {
    return this.appState;
  }

  /** Remote hosts for a fleet view; all are unreachable while the phone is silent. */
  fleetHosts(): FleetHost[] {
    const live = this.isLive;
    return this.hosts.map((host) => ({
      serverId: host.serverId,
      label: host.label,
      online: live && host.online,
      lastSeenAt:
        live && host.online ? new Date(this.syncedAt).toISOString() : (host.lastSeenAt ?? null),
      supportsTools: host.supportsTools,
      digest: host.digest,
    }));
  }

  run(request: CourierRequest, hostLabel: string): Promise<VoiceToolResult> {
    const channel = this.channel;
    if (!channel || !this.isLive) {
      return Promise.reject(new CourierTimeoutError(hostLabel));
    }
    return new Promise<VoiceToolResult>((resolve, reject) => {
      const timeoutMs = SLOW_TOOLS.has(request.tool)
        ? COURIER_CREATION_TIMEOUT_MS
        : COURIER_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(request.operationId);
        reject(new CourierTimeoutError(hostLabel));
      }, timeoutMs);
      this.pending.set(request.operationId, { resolve, reject, timer });
      try {
        channel(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.operationId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  settle(params: {
    operationId: string;
    result: VoiceToolResult | null;
    error: string | null;
  }): void {
    const entry = this.pending.get(params.operationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(params.operationId);
    if (params.result) entry.resolve(params.result);
    else entry.reject(new Error(params.error ?? "the other host did not answer"));
  }

  /** The phone's socket for this channel went away; wait for its next sync instead. */
  dropChannel(channel: CourierChannel): void {
    if (this.channel === channel) this.channel = null;
  }

  /** A call ended: forget the phone's view and fail anything still in flight. */
  reset(): void {
    this.hosts = [];
    this.syncedAt = 0;
    this.channel = null;
    for (const [operationId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("the call ended"));
      this.pending.delete(operationId);
    }
    this.options.logger.debug("Remote fleet reset");
  }
}

function stripTimes(hosts: VoiceFleetHostState[]): unknown {
  return hosts.map((host) => ({
    serverId: host.serverId,
    online: host.online,
    agents: host.digest?.agents.map((agent) => ({ ...agent, statusForMs: undefined })) ?? null,
  }));
}
