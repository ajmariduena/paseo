import {
  BROWSER_SCREENCAST_MAX_IMAGE_BYTES,
  encodeBrowserScreencastFrame,
  type BrowserScreencastFrameMetadata,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  BrowserScreencastCapture,
  BrowserScreencastPageState,
} from "@getpaseo/protocol/browser-screencast/rpc-schemas";

export const SCREENCAST_MIN_FRAME_INTERVAL_MS = 100;
export const SCREENCAST_HOST_FRAME_WINDOW = 2;
export const SCREENCAST_SNAPSHOT_DELAY_MS = 750;
const DEFAULT_QUALITY = 70;
const MIN_QUALITY = 30;
const PAGE_STATE_DEBOUNCE_MS = 50;

export interface ScreencastGuest {
  isDestroyed(): boolean;
  /** Sends a CDP command directly; screencast control must not wait behind automation. */
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onDebuggerMessage(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
  onDebuggerDetach(listener: () => void): () => void;
  onPageStateChange(listener: () => void): () => void;
  onNavigated(listener: () => void): () => void;
  onDestroyed(listener: () => void): () => void;
  readPageState(): BrowserScreencastPageState;
  invalidate(): void;
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
}

export interface ScreencastMobileViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface ScreencastSink {
  frame(bytes: Uint8Array): void;
  page(page: BrowserScreencastPageState): void;
  ended(error: { code: "browser_tab_closed" | "browser_unknown_error"; message: string }): void;
}

export interface ScreencastClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ScreencastClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface HeldFrame {
  data: string;
  metadata: BrowserScreencastFrameMetadata;
  cdpSessionId: number | null;
  snapshot: boolean;
}

/**
 * One CDP screencast for one guest. Frames are paced to a minimum interval and a small credit
 * window; the newest frame replaces an unsent one, and its CDP acknowledgement is held until it
 * is sent or replaced so Chromium does not encode frames nobody will see.
 */
export class BrowserScreencastStream {
  private sequence = 0;
  private unacked = 0;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private held: HeldFrame | null = null;
  private emitTimer: unknown = null;
  private snapshotTimer: unknown = null;
  private pageTimer: unknown = null;
  private receivedLiveFrame = false;
  private stopped = false;
  private quality: number;
  private previousThrottling: boolean | null = null;
  private mobileViewport: ScreencastMobileViewport | null = null;
  private readonly disposers: (() => void)[] = [];

  constructor(
    readonly streamId: string,
    private readonly guest: ScreencastGuest,
    private readonly capture: BrowserScreencastCapture,
    private readonly sink: ScreencastSink,
    private readonly clock: ScreencastClock = realClock,
  ) {
    this.quality = capture.quality ?? DEFAULT_QUALITY;
  }

  async start(): Promise<BrowserScreencastPageState> {
    this.disposers.push(
      this.guest.onDebuggerMessage((method, params) => {
        if (method === "Page.screencastFrame") this.receiveCdpFrame(params);
      }),
      this.guest.onDebuggerDetach(() =>
        this.end({ code: "browser_unknown_error", message: "The browser debugger detached." }),
      ),
      this.guest.onDestroyed(() =>
        this.end({ code: "browser_tab_closed", message: "The browser tab closed." }),
      ),
      this.guest.onPageStateChange(() => this.schedulePageState()),
      this.guest.onNavigated(() => void this.applyViewport().catch(() => {})),
    );
    this.previousThrottling = this.guest.getBackgroundThrottling();
    this.guest.setBackgroundThrottling(false);
    try {
      await this.startCdpScreencast();
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.guest.invalidate();
    this.snapshotTimer = this.clock.setTimeout(() => {
      this.snapshotTimer = null;
      if (!this.receivedLiveFrame) void this.captureSnapshot();
    }, SCREENCAST_SNAPSHOT_DELAY_MS);
    return this.guest.readPageState();
  }

  ack(): void {
    if (this.stopped) return;
    this.unacked = Math.max(0, this.unacked - 1);
    this.scheduleEmit();
  }

  /** Lays the page out as a phone of the viewer's size; null restores the desktop viewport. */
  async setViewport(viewport: ScreencastMobileViewport | null): Promise<void> {
    if (this.stopped) return;
    const wasMobile = this.mobileViewport !== null;
    this.mobileViewport = viewport;
    if (viewport) await this.applyViewport();
    else if (wasMobile) await this.guest.sendCommand("Emulation.clearDeviceMetricsOverride");
    else return;
    // A running screencast keeps the frame size it started with; restart it at the new viewport.
    await this.guest.sendCommand("Page.stopScreencast").catch(() => {});
    if (this.stopped) return;
    await this.startCdpScreencast();
    this.guest.invalidate();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of [this.emitTimer, this.snapshotTimer, this.pageTimer]) {
      if (timer !== null) this.clock.clearTimeout(timer);
    }
    this.emitTimer = this.snapshotTimer = this.pageTimer = null;
    for (const dispose of this.disposers.splice(0)) dispose();
    const held = this.held;
    this.held = null;
    if (this.guest.isDestroyed()) return;
    if (this.previousThrottling !== null)
      this.guest.setBackgroundThrottling(this.previousThrottling);
    if (held?.cdpSessionId != null) this.ackCdp(held.cdpSessionId);
    if (this.mobileViewport) {
      this.mobileViewport = null;
      await this.guest.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
    await this.guest.sendCommand("Page.stopScreencast").catch(() => {});
  }

  // Cross-process navigations drop emulation while the screencast stays attached.
  private async applyViewport(): Promise<void> {
    const viewport = this.mobileViewport;
    if (!viewport || this.stopped) return;
    await this.guest.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: true,
    });
    await this.guest
      .sendCommand("Emulation.setVisibleSize", { width: viewport.width, height: viewport.height })
      .catch(() => {});
  }

  private async startCdpScreencast(): Promise<void> {
    await this.guest.sendCommand("Page.startScreencast", {
      format: "jpeg",
      quality: this.quality,
      maxWidth: this.capture.maxWidth,
      maxHeight: this.capture.maxHeight,
      everyNthFrame: 1,
    });
  }

  private end(error: Parameters<ScreencastSink["ended"]>[0]): void {
    if (this.stopped) return;
    void this.stop();
    this.sink.ended(error);
  }

  private receiveCdpFrame(params: Record<string, unknown>): void {
    if (this.stopped) return;
    const cdpSessionId = typeof params.sessionId === "number" ? params.sessionId : null;
    const metadata = readCdpMetadata(params.metadata);
    if (typeof params.data !== "string" || !metadata) {
      if (cdpSessionId !== null) this.ackCdp(cdpSessionId);
      return;
    }
    this.receivedLiveFrame = true;
    const replaced = this.held;
    if (replaced?.cdpSessionId != null) this.ackCdp(replaced.cdpSessionId);
    this.held = { data: params.data, metadata, cdpSessionId, snapshot: false };
    this.scheduleEmit();
  }

  private async captureSnapshot(): Promise<void> {
    try {
      const [shot, layout] = await Promise.all([
        this.guest.sendCommand("Page.captureScreenshot", {
          format: "jpeg",
          quality: this.quality,
        }) as Promise<{ data?: unknown }>,
        this.guest.sendCommand("Page.getLayoutMetrics") as Promise<Record<string, unknown>>,
      ]);
      if (this.stopped || this.receivedLiveFrame || typeof shot.data !== "string") return;
      const metadata = readLayoutMetadata(layout);
      if (!metadata) return;
      this.held = { data: shot.data, metadata, cdpSessionId: null, snapshot: true };
      this.scheduleEmit();
    } catch {
      // A static page that cannot be captured still streams once it paints.
    }
  }

  private scheduleEmit(): void {
    if (this.stopped || !this.held || this.emitTimer !== null) return;
    if (this.unacked >= SCREENCAST_HOST_FRAME_WINDOW) return;
    const wait = this.lastEmitAt + SCREENCAST_MIN_FRAME_INTERVAL_MS - this.clock.now();
    if (wait > 0) {
      this.emitTimer = this.clock.setTimeout(() => {
        this.emitTimer = null;
        this.scheduleEmit();
      }, wait);
      return;
    }
    this.emitHeld();
  }

  private emitHeld(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    if (held.cdpSessionId !== null) this.ackCdp(held.cdpSessionId);
    const image = decodeBase64(held.data);
    if (image.byteLength > BROWSER_SCREENCAST_MAX_IMAGE_BYTES) {
      void this.lowerQuality();
      return;
    }
    this.sequence = (this.sequence + 1) >>> 0;
    this.unacked += 1;
    this.lastEmitAt = this.clock.now();
    this.sink.frame(
      encodeBrowserScreencastFrame({
        id: this.streamId,
        sequence: this.sequence,
        format: "jpeg",
        snapshot: held.snapshot,
        metadata: held.metadata,
        image,
      }),
    );
  }

  private async lowerQuality(): Promise<void> {
    if (this.quality <= MIN_QUALITY) return;
    this.quality = Math.max(MIN_QUALITY, this.quality - 20);
    await this.guest.sendCommand("Page.stopScreencast").catch(() => {});
    if (this.stopped) return;
    await this.startCdpScreencast().catch(() => {});
  }

  private ackCdp(sessionId: number): void {
    void this.guest.sendCommand("Page.screencastFrameAck", { sessionId }).catch(() => {});
  }

  private schedulePageState(): void {
    if (this.stopped || this.pageTimer !== null) return;
    this.pageTimer = this.clock.setTimeout(() => {
      this.pageTimer = null;
      if (!this.stopped && !this.guest.isDestroyed()) this.sink.page(this.guest.readPageState());
    }, PAGE_STATE_DEBOUNCE_MS);
  }
}

function readCdpMetadata(value: unknown): BrowserScreencastFrameMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const deviceWidth = positive(record.deviceWidth);
  const deviceHeight = positive(record.deviceHeight);
  if (deviceWidth === null || deviceHeight === null) return null;
  return {
    deviceWidth,
    deviceHeight,
    ...finiteField("pageScaleFactor", record.pageScaleFactor),
    ...finiteField("scrollOffsetX", record.scrollOffsetX),
    ...finiteField("scrollOffsetY", record.scrollOffsetY),
    ...finiteField("offsetTop", record.offsetTop),
    ...finiteField("timestamp", record.timestamp),
  };
}

function readLayoutMetadata(
  layout: Record<string, unknown>,
): BrowserScreencastFrameMetadata | null {
  const viewport = (layout.cssVisualViewport ?? layout.visualViewport) as
    | Record<string, unknown>
    | undefined;
  if (!viewport) return null;
  const deviceWidth = positive(viewport.clientWidth);
  const deviceHeight = positive(viewport.clientHeight);
  if (deviceWidth === null || deviceHeight === null) return null;
  return {
    deviceWidth,
    deviceHeight,
    ...finiteField("pageScaleFactor", viewport.scale),
    ...finiteField("scrollOffsetX", viewport.pageX),
    ...finiteField("scrollOffsetY", viewport.pageY),
  };
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteField<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  return typeof value === "number" && Number.isFinite(value)
    ? ({ [key]: value } as Record<K, number>)
    : {};
}

function decodeBase64(data: string): Uint8Array {
  const buffer = Buffer.from(data, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
