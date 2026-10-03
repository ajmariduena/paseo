export type VoiceNoticeReason = "permission" | "error" | "finished" | "started" | "progress";

export interface VoiceNotice {
  agentId: string;
  reason: VoiceNoticeReason;
}

const PRIORITY: Record<VoiceNoticeReason, number> = {
  permission: 0,
  error: 1,
  finished: 2,
  started: 3,
  progress: 4,
};

export interface VoiceNoticeQueueOptions {
  /** Routine notices wait this long so agents finishing together are announced together. */
  batchWindowMs: number;
  urgentDelayMs: number;
  busyRetryMs: number;
  isBusy: () => boolean;
  isStale: (notice: VoiceNotice) => boolean;
  deliver: (notices: VoiceNotice[]) => Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class VoiceNoticeQueue {
  private readonly pending = new Map<string, VoiceNotice>();
  private timer: unknown = null;
  private flushAt: number | null = null;
  private delivering = false;
  private closed = false;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: VoiceNoticeQueueOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get size(): number {
    return this.pending.size;
  }

  push(notice: VoiceNotice): void {
    if (this.closed) return;
    const existing = this.pending.get(notice.agentId);
    if (!existing || PRIORITY[notice.reason] <= PRIORITY[existing.reason]) {
      this.pending.set(notice.agentId, notice);
    }
    const urgent = notice.reason === "permission" || notice.reason === "error";
    const delay = urgent ? this.options.urgentDelayMs : this.options.batchWindowMs;
    this.schedule(delay);
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.cancelTimer();
  }

  private schedule(delayMs: number): void {
    const target = this.now() + delayMs;
    if (this.flushAt !== null && this.flushAt <= target) return;
    this.cancelTimer();
    this.flushAt = target;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flushAt = null;
      void this.flush();
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.flushAt = null;
  }

  private async flush(): Promise<void> {
    if (this.closed || this.delivering) return;
    for (const [agentId, notice] of this.pending) {
      if (this.options.isStale(notice)) this.pending.delete(agentId);
    }
    if (this.pending.size === 0) return;
    if (this.options.isBusy()) {
      this.schedule(this.options.busyRetryMs);
      return;
    }
    const batch = [...this.pending.values()].sort(
      (left, right) => PRIORITY[left.reason] - PRIORITY[right.reason],
    );
    this.pending.clear();
    this.delivering = true;
    try {
      await this.options.deliver(batch);
    } finally {
      this.delivering = false;
      if (this.pending.size > 0 && !this.closed) this.schedule(this.options.busyRetryMs);
    }
  }
}
