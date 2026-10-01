import { describe, expect, test } from "vitest";
import {
  BROWSER_AUTOMATION_COMMAND_NAMES,
  type BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { BrowserScreencastError } from "@getpaseo/protocol/browser-screencast/rpc-schemas";
import {
  BrowserToolsBroker,
  type BrowserHostClient,
  type BrowserHostDirectedScreencastMessage,
} from "../browser-tools/broker.js";
import { BrowserScreencastBroker, VIEWER_CREDIT_RESET_MS } from "./stream-broker.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "workspace-1";
const CAPTURE = { maxWidth: 800, maxHeight: 600 };
const PAGE = {
  url: "https://example.com/",
  title: "Example",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

class FakeHost implements BrowserHostClient {
  readonly hostKind = "desktop app";
  readonly supportedCommands = [...BROWSER_AUTOMATION_COMMAND_NAMES];
  readonly sent: BrowserHostDirectedScreencastMessage[] = [];
  readonly screencast;
  startReply: { ok: boolean; error?: BrowserScreencastError } = { ok: true };

  constructor(
    readonly id: string,
    private readonly tools: () => BrowserToolsBroker,
    private readonly screencastBroker: () => BrowserScreencastBroker,
    private readonly tabs: string[],
    supportsScreencast = true,
  ) {
    this.screencast = supportsScreencast
      ? {
          send: (message: BrowserHostDirectedScreencastMessage) => {
            this.sent.push(message);
            if (message.type === "browser.host.screencast.start.request") {
              queueMicrotask(() =>
                this.screencastBroker().receiveHostReply(
                  { requestId: message.requestId, page: PAGE, ...this.startReply },
                  [this.id],
                ),
              );
            }
          },
        }
      : undefined;
  }

  sendBrowserAutomationRequest(request: BrowserAutomationExecuteRequest): void {
    queueMicrotask(() =>
      this.tools().receiveResponse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: request.requestId,
          ok: true,
          result: {
            command: "list_tabs",
            tabs: this.tabs.map((browserId) => ({
              browserId,
              workspaceId: WORKSPACE_ID,
              url: PAGE.url,
              title: PAGE.title,
              isActive: false,
              isLoading: false,
            })),
          },
        },
      }),
    );
  }

  streamId(): string {
    const start = this.sent.find(
      (message) => message.type === "browser.host.screencast.start.request",
    );
    if (!start) throw new Error("No stream was started");
    return start.streamId;
  }
}

interface RecordingViewer {
  id: string;
  frames: Uint8Array[];
  pages: unknown[];
  ended: BrowserScreencastError[];
  sendFrame(frame: Uint8Array): void;
  sendPage(page: unknown): void;
  end(error: BrowserScreencastError): void;
}

function recordingViewer(id: string): RecordingViewer {
  const viewer: RecordingViewer = {
    id,
    frames: [],
    pages: [],
    ended: [],
    sendFrame: (frame) => viewer.frames.push(frame),
    sendPage: (page) => viewer.pages.push(page),
    end: (error) => viewer.ended.push(error),
  };
  return viewer;
}

function setup(options: { now?: () => number; screencast?: boolean } = {}) {
  const tools = new BrowserToolsBroker({ defaultTimeoutMs: 1_000 });
  const broker = new BrowserScreencastBroker({ hosts: tools, now: options.now });
  const hostA = new FakeHost(
    "host-a",
    () => tools,
    () => broker,
    [BROWSER_ID],
    options.screencast,
  );
  const hostB = new FakeHost(
    "host-b",
    () => tools,
    () => broker,
    [],
  );
  const unregisterA = tools.registerClient(hostA);
  tools.registerClient(hostB);
  return { tools, broker, hostA, hostB, unregisterA };
}

function hostFrame(streamId: string, sequence: number): { bytes: Uint8Array } {
  return {
    bytes: encodeBrowserScreencastFrame({
      id: streamId,
      sequence,
      format: "jpeg",
      snapshot: false,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
      image: new Uint8Array([0xff, 0xd8, sequence]),
    }),
  };
}

function sendHostFrame(broker: BrowserScreencastBroker, host: FakeHost, sequence: number) {
  const { bytes } = hostFrame(host.streamId(), sequence);
  const frame = decodeBrowserScreencastFrame(bytes);
  if (!frame) throw new Error("frame did not decode");
  return broker.receiveHostFrame(frame, bytes, [host.id]);
}

const VIEWER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("BrowserScreencastBroker", () => {
  test("starts one stream on the host that owns the tab and addresses frames per viewer", async () => {
    const { broker, hostA, hostB } = setup();
    const first = recordingViewer(VIEWER_A);
    const second = recordingViewer(VIEWER_B);

    const added = await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: first,
    });
    expect(added).toEqual({ ok: true, page: PAGE });
    await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: second,
    });
    broker.activateViewer(first.id);
    broker.activateViewer(second.id);

    expect(
      hostA.sent.filter((m) => m.type === "browser.host.screencast.start.request"),
    ).toHaveLength(1);
    expect(hostB.sent).toEqual([]);

    expect(sendHostFrame(broker, hostA, 1)).toBe(true);
    expect(decodeBrowserScreencastFrame(first.frames[0]!)?.id).toBe(first.id);
    expect(decodeBrowserScreencastFrame(second.frames[0]!)?.id).toBe(second.id);
    expect(hostA.sent.at(-1)).toMatchObject({
      type: "browser.host.screencast.ack_frame.request",
      sequence: 1,
    });
  });

  test("a slow viewer keeps only its newest frame without holding back another viewer", async () => {
    const { broker, hostA } = setup();
    const slow = recordingViewer(VIEWER_A);
    const fast = recordingViewer(VIEWER_B);
    for (const sink of [slow, fast]) {
      await broker.addViewer({
        workspaceId: WORKSPACE_ID,
        browserId: BROWSER_ID,
        capture: CAPTURE,
        sink,
      });
      broker.activateViewer(sink.id);
    }

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      sendHostFrame(broker, hostA, sequence);
      broker.ackViewerFrame(fast.id);
    }

    expect(fast.frames.map((frame) => decodeBrowserScreencastFrame(frame)?.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(slow.frames.map((frame) => decodeBrowserScreencastFrame(frame)?.sequence)).toEqual([
      1, 2,
    ]);

    broker.ackViewerFrame(slow.id);
    expect(decodeBrowserScreencastFrame(slow.frames.at(-1)!)?.sequence).toBe(5);
  });

  test("restores credit for a viewer whose acknowledgements were lost", async () => {
    let now = 0;
    const { broker, hostA } = setup({ now: () => now });
    const viewer = recordingViewer(VIEWER_A);
    await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: viewer,
    });
    broker.activateViewer(viewer.id);

    sendHostFrame(broker, hostA, 1);
    sendHostFrame(broker, hostA, 2);
    sendHostFrame(broker, hostA, 3);
    expect(viewer.frames).toHaveLength(2);

    now += VIEWER_CREDIT_RESET_MS + 1;
    sendHostFrame(broker, hostA, 4);
    expect(decodeBrowserScreencastFrame(viewer.frames.at(-1)!)?.sequence).toBe(4);
  });

  test("sends the latest frame when a viewer activates and nothing before", async () => {
    const { broker, hostA } = setup();
    const first = recordingViewer(VIEWER_A);
    await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: first,
    });
    sendHostFrame(broker, hostA, 7);
    expect(first.frames).toEqual([]);

    broker.activateViewer(first.id);
    expect(decodeBrowserScreencastFrame(first.frames[0]!)?.sequence).toBe(7);
  });

  test("ignores frames from a host that does not own the stream", async () => {
    const { broker, hostA } = setup();
    const viewer = recordingViewer(VIEWER_A);
    await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: viewer,
    });
    broker.activateViewer(viewer.id);

    const { bytes } = hostFrame(hostA.streamId(), 1);
    expect(broker.receiveHostFrame(decodeBrowserScreencastFrame(bytes)!, bytes, ["host-b"])).toBe(
      false,
    );
    expect(viewer.frames).toEqual([]);
  });

  test("stops the host stream when the last viewer leaves", async () => {
    const { broker, hostA } = setup();
    const first = recordingViewer(VIEWER_A);
    const second = recordingViewer(VIEWER_B);
    for (const sink of [first, second]) {
      await broker.addViewer({
        workspaceId: WORKSPACE_ID,
        browserId: BROWSER_ID,
        capture: CAPTURE,
        sink,
      });
    }

    broker.removeViewer(first.id);
    expect(hostA.sent.some((m) => m.type === "browser.host.screencast.stop.request")).toBe(false);
    broker.removeViewer(second.id);
    expect(hostA.sent.at(-1)).toEqual({
      type: "browser.host.screencast.stop.request",
      streamId: hostA.streamId(),
    });
    expect(broker.getStreamCount()).toBe(0);
  });

  test("ends viewers when their host disconnects and never moves them to another host", async () => {
    const { broker, hostA, hostB, unregisterA } = setup();
    const viewer = recordingViewer(VIEWER_A);
    await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: viewer,
    });
    broker.activateViewer(viewer.id);

    unregisterA();

    expect(viewer.ended).toEqual([
      { code: "browser_no_host", message: "The desktop app disconnected." },
    ]);
    expect(broker.getStreamCount()).toBe(0);
    expect(hostB.sent).toEqual([]);
    expect(hostA.sent.some((m) => m.type === "browser.host.screencast.stop.request")).toBe(false);
  });

  test("reports a host that cannot stream without starting anything", async () => {
    const { broker } = setup({ screencast: false });
    const result = await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: recordingViewer(VIEWER_A),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "browser_unsupported" } });
    expect(broker.getStreamCount()).toBe(0);
  });

  test("returns the host's start failure and forgets the stream", async () => {
    const { broker, hostA } = setup();
    hostA.startReply = {
      ok: false,
      error: { code: "browser_tab_not_found", message: "No browser tab found." },
    };
    const result = await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: recordingViewer(VIEWER_A),
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "browser_tab_not_found", message: "No browser tab found." },
    });
    expect(broker.getStreamCount()).toBe(0);
  });

  test("routes input to the stream's host and returns its reply", async () => {
    const { broker, hostA } = setup();
    const viewer = recordingViewer(VIEWER_A);
    await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: viewer,
    });

    const reply = broker.sendInput(viewer.id, { kind: "click", x: 10, y: 20 });
    const request = hostA.sent.at(-1);
    if (request?.type !== "browser.host.screencast.input.request") throw new Error("no input");
    expect(request.input).toEqual({ kind: "click", x: 10, y: 20 });
    expect(broker.receiveHostReply({ requestId: request.requestId, ok: true }, ["host-b"])).toBe(
      false,
    );
    expect(broker.receiveHostReply({ requestId: request.requestId, ok: true }, ["host-a"])).toBe(
      true,
    );
    await expect(reply).resolves.toEqual({ ok: true });
  });

  test("reports a missing tab when several desktops are connected and none lists it", async () => {
    const { broker } = setup();
    const result = await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: "33333333-3333-4333-8333-333333333333",
      capture: CAPTURE,
      sink: recordingViewer(VIEWER_A),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "browser_tab_not_found" } });
  });

  test("asks the only connected desktop for a saved tab it has not listed yet", async () => {
    const tools = new BrowserToolsBroker({ defaultTimeoutMs: 1_000 });
    const broker = new BrowserScreencastBroker({ hosts: tools });
    const host = new FakeHost(
      "host-a",
      () => tools,
      () => broker,
      [],
    );
    tools.registerClient(host);
    const result = await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: recordingViewer(VIEWER_A),
    });
    expect(result).toEqual({ ok: true, page: PAGE });
    expect(host.streamId()).toEqual(expect.any(String));
  });

  test("returns no host when no desktop is connected", async () => {
    const tools = new BrowserToolsBroker({ defaultTimeoutMs: 1_000 });
    const broker = new BrowserScreencastBroker({ hosts: tools });
    const result = await broker.addViewer({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: CAPTURE,
      sink: recordingViewer(VIEWER_A),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "browser_no_host" } });
  });
});
