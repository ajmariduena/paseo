import { describe, expect, it } from "vitest";
import type { DesktopBrowserScreencastBridge, DesktopBrowserScreencastEvent } from "@/desktop/host";
import { createBrowserScreencastHostHandler } from "./host-handler";

const STREAM_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const PAGE = {
  url: "https://example.com/",
  title: "Example",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

function setup(startResult: Awaited<ReturnType<DesktopBrowserScreencastBridge["start"]>>) {
  const sizes: unknown[] = [];
  const sentMessages: unknown[] = [];
  const sentFrames: Uint8Array[] = [];
  const stopped: string[] = [];
  const acked: string[] = [];
  let emitFrame: (streamId: string, frame: Uint8Array) => void = () => {};
  let emitEvent: (streamId: string, event: DesktopBrowserScreencastEvent) => void = () => {};
  const bridge: DesktopBrowserScreencastBridge = {
    start: async () => startResult,
    stop: async (streamId) => {
      stopped.push(streamId);
    },
    ack: (streamId) => acked.push(streamId),
    input: async () => ({ ok: true }),
    onFrame: (handler) => {
      emitFrame = handler;
      return () => {};
    },
    onEvent: (handler) => {
      emitEvent = handler;
      return () => {};
    },
  };
  const handler = createBrowserScreencastHostHandler({
    bridge,
    sizeGuest: (browserId, size) => sizes.push([browserId, size]),
    client: {
      sendBrowserScreencastHostFrame: (frame) => sentFrames.push(frame),
      sendBrowserScreencastHostMessage: (message) => sentMessages.push(message),
    },
  });
  const start = async () => {
    handler.handle({
      type: "browser.host.screencast.start.request",
      requestId: "req-1",
      streamId: STREAM_ID,
      browserId: BROWSER_ID,
      workspaceId: "workspace-1",
      capture: { maxWidth: 800, maxHeight: 600 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    sizes,
    handler,
    start,
    sentMessages,
    sentFrames,
    stopped,
    acked,
    emitFrame: (streamId: string) => emitFrame(streamId, new Uint8Array([1])),
    emitEvent: (streamId: string, event: DesktopBrowserScreencastEvent) =>
      emitEvent(streamId, event),
  };
}

describe("browser screencast host handler", () => {
  it("answers a start request and forwards frames only for started streams", async () => {
    const host = setup({ ok: true, page: PAGE });
    host.emitFrame(STREAM_ID);
    expect(host.sentFrames).toEqual([]);

    await host.start();
    expect(host.sentMessages).toEqual([
      {
        type: "browser.host.screencast.start.response",
        payload: { requestId: "req-1", ok: true, page: PAGE },
      },
    ]);
    host.emitFrame(STREAM_ID);
    expect(host.sentFrames).toHaveLength(1);

    host.handler.handle({
      type: "browser.host.screencast.ack_frame.request",
      streamId: STREAM_ID,
      sequence: 1,
    });
    expect(host.acked).toEqual([STREAM_ID]);
  });

  it("reports a failed start and forwards nothing for it", async () => {
    const host = setup({
      ok: false,
      error: { code: "browser_tab_not_found", message: "No browser tab found." },
    });
    await host.start();
    expect(host.sentMessages).toEqual([
      {
        type: "browser.host.screencast.start.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: { code: "browser_tab_not_found", message: "No browser tab found." },
        },
      },
    ]);
    host.emitFrame(STREAM_ID);
    expect(host.sentFrames).toEqual([]);
  });

  it("reports a stream that ended on the desktop and then ignores it", async () => {
    const host = setup({ ok: true, page: PAGE });
    await host.start();
    host.emitEvent(STREAM_ID, {
      kind: "ended",
      error: { code: "browser_tab_closed", message: "The browser tab closed." },
    });
    expect(host.sentMessages.at(-1)).toEqual({
      type: "browser.host.screencast.report.request",
      streamId: STREAM_ID,
      event: {
        kind: "ended",
        error: { code: "browser_tab_closed", message: "The browser tab closed." },
      },
    });
    host.emitFrame(STREAM_ID);
    expect(host.sentFrames).toEqual([]);
  });

  it("stops every stream when the daemon registration is replaced", async () => {
    const host = setup({ ok: true, page: PAGE });
    await host.start();
    host.handler.reset();
    expect(host.stopped).toEqual([STREAM_ID]);
    host.emitFrame(STREAM_ID);
    expect(host.sentFrames).toEqual([]);
  });

  it("rejects input for a stream it does not own", async () => {
    const host = setup({ ok: true, page: PAGE });
    host.handler.handle({
      type: "browser.host.screencast.input.request",
      requestId: "req-2",
      streamId: STREAM_ID,
      input: { kind: "click", x: 1, y: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.sentMessages).toEqual([
      {
        type: "browser.host.screencast.input.response",
        payload: {
          requestId: "req-2",
          ok: false,
          error: { code: "browser_tab_closed", message: "The browser stream ended." },
        },
      },
    ]);
  });

  it("sizes the guest for mobile view and restores it when the stream stops", async () => {
    const host = setup({ ok: true, page: PAGE });
    await host.start();
    host.handler.handle({
      type: "browser.host.screencast.input.request",
      requestId: "req-3",
      streamId: STREAM_ID,
      input: { kind: "viewport", mobile: { width: 390, height: 700, deviceScaleFactor: 2 } },
    });
    expect(host.sizes).toEqual([[BROWSER_ID, { width: 390, height: 700 }]]);

    host.handler.handle({ type: "browser.host.screencast.stop.request", streamId: STREAM_ID });
    expect(host.sizes.at(-1)).toEqual([BROWSER_ID, null]);
  });

  it("leaves the guest size alone for a stream that stayed in web view", async () => {
    const host = setup({ ok: true, page: PAGE });
    await host.start();
    host.handler.reset();
    expect(host.sizes).toEqual([]);
  });
});
