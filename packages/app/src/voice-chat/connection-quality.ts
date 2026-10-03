export interface ConnectionQualityOptions {
  /** A live call drops to messages mode after the host is unreachable this long. */
  degradeAfterMs: number;
  /** This many disconnects inside the window also count as unstable. */
  flapCount: number;
  flapWindowMs: number;
  /** Messages mode returns to live only after the link holds this long. */
  recoverAfterMs: number;
  maxRecoverAfterMs: number;
}

export const DEFAULT_CONNECTION_QUALITY_OPTIONS: ConnectionQualityOptions = {
  degradeAfterMs: 3_000,
  flapCount: 2,
  flapWindowMs: 60_000,
  recoverAfterMs: 45_000,
  maxRecoverAfterMs: 5 * 60_000,
};

/**
 * Decides when a global voice call should switch between live and messages mode from the
 * host connection's history. Recovery needs a long stable stretch, and every relapse right
 * after recovering doubles it, so a flaky link settles in messages mode instead of flapping.
 */
export class ConnectionQuality {
  private readonly options: ConnectionQualityOptions;
  private connected: boolean;
  private changedAt: number;
  private disconnects: number[] = [];
  private recoverAfterMs: number;
  private recoveredAt: number | null = null;

  constructor(connected: boolean, now: number, options: Partial<ConnectionQualityOptions> = {}) {
    this.options = { ...DEFAULT_CONNECTION_QUALITY_OPTIONS, ...options };
    this.connected = connected;
    this.changedAt = now;
    this.recoverAfterMs = this.options.recoverAfterMs;
  }

  update(connected: boolean, now: number): void {
    if (connected === this.connected) return;
    this.connected = connected;
    this.changedAt = now;
    if (!connected) {
      this.disconnects = [...this.disconnects, now].filter(
        (at) => now - at <= this.options.flapWindowMs,
      );
    }
  }

  shouldDegrade(now: number): boolean {
    if (!this.connected && now - this.changedAt >= this.options.degradeAfterMs) return true;
    return (
      this.disconnects.filter((at) => now - at <= this.options.flapWindowMs).length >=
      this.options.flapCount
    );
  }

  shouldRecover(now: number): boolean {
    return this.connected && now - this.changedAt >= this.recoverAfterMs;
  }

  noteDegraded(now: number): void {
    if (this.recoveredAt !== null && now - this.recoveredAt < this.options.flapWindowMs * 2) {
      this.recoverAfterMs = Math.min(this.recoverAfterMs * 2, this.options.maxRecoverAfterMs);
    }
    this.disconnects = [];
  }

  noteRecovered(now: number): void {
    this.recoveredAt = now;
  }

  get recoverDelayMs(): number {
    return this.recoverAfterMs;
  }
}
