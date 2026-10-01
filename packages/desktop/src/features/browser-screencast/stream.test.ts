import { describe, expect, it } from "vitest";
import { decodeBrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/index";
import {
  BrowserScreencastStream,
  SCREENCAST_MIN_FRAME_INTERVAL_MS,
  SCREENCAST_SNAPSHOT_DELAY_MS,
  type ScreencastClock,
  type ScreencastGuest,
} from "./stream";

const STREAM_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const METADATA = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1 };
const PAGE = {
  url: "https://example.com/",
  title: "Example",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

class FakeClock implements ScreencastClock {
  time = 0;
  private timers: { at: number; callback: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, callback, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.callback();
    }
    this.time = target;
  }
}

class FakeGuest implements ScreencastGuest {
  readonly commands: { method: string; params?: Record<string, unknown> }[] = [];
  throttling = true;
  destroyed = false;
  invalidated = 0;
  screenshot: string | null = Buffer.from([0xff, 0xd8, 0x99]).toString("base64");
  private messageListener: ((method: string, params: Record<string, unknown>) => void) | null =
    null;
  private destroyedListener: (() => void) | null = null;
  private pageListener: (() => void) | null = null;
  private navigatedListener: (() => void) | null = null;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    if (method === "Page.captureScreenshot") return { data: this.screenshot };
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800, scale: 1, pageY: 0 } };
    }
    return {};
  }

  onDebuggerMessage(listener: (method: string, params: Record<string, unknown>) => void) {
    this.messageListener = listener;
    return () => {
      this.messageListener = null;
    };
  }

  onDebuggerDetach() {
    return () => {};
  }

  onNavigated(listener: () => void) {
    this.navigatedListener = listener;
    return () => {
      this.navigatedListener = null;
    };
  }

  navigate(): void {
    this.navigatedListener?.();
  }

  onPageStateChange(listener: () => void) {
    this.pageListener = listener;
    return () => {
      this.pageListener = null;
    };
  }

  onDestroyed(listener: () => void) {
    this.destroyedListener = listener;
    return () => {
      this.destroyedListener = null;
    };
  }

  readPageState() {
    return PAGE;
  }

  invalidate(): void {
    this.invalidated += 1;
  }

  getBackgroundThrottling(): boolean {
    return this.throttling;
  }

  setBackgroundThrottling(allowed: boolean): void {
    this.throttling = allowed;
  }

  paint(sessionId: number, byte = sessionId): void {
    this.messageListener?.("Page.screencastFrame", {
      data: Buffer.from([0xff, 0xd8, byte]).toString("base64"),
      metadata: METADATA,
      sessionId,
    });
  }

  changePage(): void {
    this.pageListener?.();
  }

  destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }

  acks(): unknown[] {
    return this.commands
      .filter((command) => command.method === "Page.screencastFrameAck")
      .map((command) => command.params?.sessionId);
  }
}

async function startStream() {
  const clock = new FakeClock();
  const guest = new FakeGuest();
  const frames: Uint8Array[] = [];
  const pages: unknown[] = [];
  const ended: unknown[] = [];
  const stream = new BrowserScreencastStream(
    STREAM_ID,
    guest,
    { maxWidth: 800, maxHeight: 600 },
    {
      frame: (bytes) => frames.push(bytes),
      page: (page) => pages.push(page),
      ended: (error) => ended.push(error),
    },
    clock,
  );
  const page = await stream.start();
  return { clock, guest, frames, pages, ended, stream, page };
}

const sequences = (frames: Uint8Array[]) =>
  frames.map((frame) => decodeBrowserScreencastFrame(frame)?.sequence);

describe("BrowserScreencastStream", () => {
  it("starts a capped JPEG screencast with throttling disabled and forces a paint", async () => {
    const { guest, page } = await startStream();
    expect(page).toEqual(PAGE);
    expect(guest.commands[0]).toEqual({
      method: "Page.startScreencast",
      params: { format: "jpeg", quality: 70, maxWidth: 800, maxHeight: 600, everyNthFrame: 1 },
    });
    expect(guest.throttling).toBe(false);
    expect(guest.invalidated).toBe(1);
  });

  it("paces frames and holds Chromium's acknowledgement until a frame is sent or replaced", async () => {
    const { clock, guest, frames } = await startStream();
    guest.paint(1);
    expect(sequences(frames)).toEqual([1]);
    expect(guest.acks()).toEqual([1]);

    clock.advance(10);
    guest.paint(2);
    guest.paint(3);
    expect(frames).toHaveLength(1);
    expect(guest.acks()).toEqual([1, 2]);

    clock.advance(SCREENCAST_MIN_FRAME_INTERVAL_MS);
    expect(sequences(frames)).toEqual([1, 2]);
    expect(decodeBrowserScreencastFrame(frames[1]!)?.image[2]).toBe(3);
    expect(guest.acks()).toEqual([1, 2, 3]);
  });

  it("waits for credit from the daemon before sending more frames", async () => {
    const { clock, guest, frames, stream } = await startStream();
    guest.paint(1);
    clock.advance(SCREENCAST_MIN_FRAME_INTERVAL_MS);
    guest.paint(2);
    clock.advance(SCREENCAST_MIN_FRAME_INTERVAL_MS);
    guest.paint(3);
    clock.advance(SCREENCAST_MIN_FRAME_INTERVAL_MS * 3);
    expect(frames).toHaveLength(2);

    stream.ack();
    expect(frames).toHaveLength(3);
  });

  it("sends a snapshot when a static page never paints", async () => {
    const { clock, frames } = await startStream();
    clock.advance(SCREENCAST_SNAPSHOT_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    const decoded = decodeBrowserScreencastFrame(frames[0]!);
    expect(decoded).toMatchObject({
      snapshot: true,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
  });

  it("skips the snapshot once a live frame arrived", async () => {
    const { clock, guest, frames } = await startStream();
    guest.paint(1);
    clock.advance(SCREENCAST_SNAPSHOT_DELAY_MS);
    await Promise.resolve();
    expect(guest.commands.some((command) => command.method === "Page.captureScreenshot")).toBe(
      false,
    );
    expect(frames).toHaveLength(1);
  });

  it("reports page changes once per burst", async () => {
    const { clock, guest, pages } = await startStream();
    guest.changePage();
    guest.changePage();
    clock.advance(100);
    expect(pages).toEqual([PAGE]);
  });

  it("restores throttling and stops the screencast on stop", async () => {
    const { guest, stream } = await startStream();
    guest.paint(1);
    guest.paint(2);
    await stream.stop();
    expect(guest.throttling).toBe(true);
    expect(guest.commands.at(-1)?.method).toBe("Page.stopScreencast");
    expect(guest.acks()).toEqual([1, 2]);
  });

  it("emulates the viewer's phone viewport, reapplies it after navigation, and clears it on stop", async () => {
    const { guest, stream } = await startStream();
    const viewport = { width: 390, height: 700, deviceScaleFactor: 2 };
    await stream.setViewport(viewport);
    const overrides = () =>
      guest.commands.filter((command) => command.method === "Emulation.setDeviceMetricsOverride");
    expect(overrides().at(-1)?.params).toEqual({ ...viewport, mobile: true });

    guest.navigate();
    await Promise.resolve();
    expect(overrides()).toHaveLength(2);

    await stream.stop();
    expect(guest.commands.map((command) => command.method)).toContain(
      "Emulation.clearDeviceMetricsOverride",
    );
  });

  it("restores the desktop viewport when the viewer returns to web view", async () => {
    const { guest, stream } = await startStream();
    await stream.setViewport({ width: 390, height: 700, deviceScaleFactor: 2 });
    await stream.setViewport(null);
    expect(guest.commands.slice(-3).map((command) => command.method)).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "Page.stopScreencast",
      "Page.startScreencast",
    ]);
    await stream.stop();
    expect(
      guest.commands.filter((command) => command.method === "Emulation.clearDeviceMetricsOverride"),
    ).toHaveLength(1);
  });

  it("ends when the guest is destroyed", async () => {
    const { guest, ended, frames } = await startStream();
    guest.destroy();
    guest.paint(1);
    expect(ended).toEqual([{ code: "browser_tab_closed", message: "The browser tab closed." }]);
    expect(frames).toEqual([]);
  });
});
