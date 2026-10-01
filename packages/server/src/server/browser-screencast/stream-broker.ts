import { randomUUID } from "node:crypto";
import {
  readdressBrowserScreencastFrame,
  type BrowserScreencastFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  BrowserScreencastCapture,
  BrowserScreencastError,
  BrowserScreencastInput,
  BrowserScreencastPageState,
} from "@getpaseo/protocol/browser-screencast/rpc-schemas";
import type { BrowserToolsBroker } from "../browser-tools/broker.js";

/** Frames a viewer may hold unacknowledged before newer frames replace its pending one. */
export const VIEWER_FRAME_WINDOW = 2;
/** A viewer whose acknowledgements stop arriving gets fresh credit after this long. */
export const VIEWER_CREDIT_RESET_MS = 5_000;
const HOST_REQUEST_TIMEOUT_MS = 15_000;

export interface BrowserScreencastViewerSink {
  id: string;
  sendFrame(frame: Uint8Array): void;
  sendPage(page: BrowserScreencastPageState): void;
  end(error: BrowserScreencastError): void;
}

interface Viewer {
  sink: BrowserScreencastViewerSink;
  stream: HostStream;
  ready: boolean;
  inFlight: number;
  lastSentAt: number;
  pending: Uint8Array | null;
}

interface HostStream {
  streamId: string;
  hostId: string;
  browserId: string;
  workspaceId: string;
  viewers: Map<string, Viewer>;
  started: Promise<StartResult>;
  latestFrame: Uint8Array | null;
  page: BrowserScreencastPageState | null;
}

type StartResult = { ok: true } | { ok: false; error: BrowserScreencastError };

interface PendingHostRequest {
  hostId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: HostReply) => void;
}

interface HostReply {
  ok: boolean;
  page?: BrowserScreencastPageState;
  error?: BrowserScreencastError;
}

export type AddViewerResult =
  | { ok: true; page: BrowserScreencastPageState | null }
  | { ok: false; error: BrowserScreencastError };

export interface BrowserScreencastBrokerOptions {
  hosts: BrowserToolsBroker;
  now?: () => number;
  hostRequestTimeoutMs?: number;
}

/**
 * Daemon-wide routing between desktop browser hosts and remote viewers. Each viewer gets a
 * bounded credit window, so a slow phone only ever skips its own frames.
 */
export class BrowserScreencastBroker {
  private readonly hosts: BrowserToolsBroker;
  private readonly now: () => number;
  private readonly hostRequestTimeoutMs: number;
  private readonly streams = new Map<string, HostStream>();
  private readonly streamsByTab = new Map<string, HostStream>();
  private readonly viewers = new Map<string, Viewer>();
  private readonly pending = new Map<string, PendingHostRequest>();
  private readonly disposeHostListener: () => void;

  constructor(options: BrowserScreencastBrokerOptions) {
    this.hosts = options.hosts;
    this.now = options.now ?? Date.now;
    this.hostRequestTimeoutMs = options.hostRequestTimeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
    this.disposeHostListener = this.hosts.onHostUnregistered((hostId) =>
      this.handleHostGone(hostId),
    );
  }

  dispose(): void {
    this.disposeHostListener();
    for (const hostId of new Set([...this.streams.values()].map((stream) => stream.hostId))) {
      this.handleHostGone(hostId);
    }
  }

  async addViewer(input: {
    workspaceId: string;
    browserId: string;
    capture: BrowserScreencastCapture;
    sink: BrowserScreencastViewerSink;
  }): Promise<AddViewerResult> {
    const hostId = await this.hosts.resolveBrowserHost({
      browserId: input.browserId,
      workspaceId: input.workspaceId,
    });
    if (!hostId) {
      return {
        ok: false,
        error:
          this.hosts.getRegisteredClientCount() === 0
            ? {
                code: "browser_no_host",
                message: "The desktop app hosting this browser tab is not connected.",
              }
            : { code: "browser_tab_not_found", message: "No connected desktop has this tab." },
      };
    }
    const channel = this.hosts.getScreencastChannel(hostId);
    if (!channel) {
      return {
        ok: false,
        error: {
          code: "browser_unsupported",
          message: "Update the desktop app to view its browser tabs remotely.",
        },
      };
    }

    const tabKey = `${hostId}\u0000${input.browserId}`;
    let stream = this.streamsByTab.get(tabKey);
    if (stream && stream.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: { code: "browser_tab_not_found", message: "Browser tab not found." },
      };
    }
    if (!stream) {
      const streamId = randomUUID();
      const created: HostStream = {
        streamId,
        hostId,
        browserId: input.browserId,
        workspaceId: input.workspaceId,
        viewers: new Map(),
        latestFrame: null,
        page: null,
        started: Promise.resolve({ ok: true }),
      };
      created.started = this.requestHost(hostId, (requestId) =>
        channel.send({
          type: "browser.host.screencast.start.request",
          requestId,
          streamId,
          browserId: input.browserId,
          workspaceId: input.workspaceId,
          capture: input.capture,
        }),
      ).then((reply): StartResult => {
        if (reply.page && !created.page) created.page = reply.page;
        return reply.ok
          ? { ok: true }
          : {
              ok: false,
              error: reply.error ?? {
                code: "browser_unknown_error",
                message: "The desktop app could not start the browser stream.",
              },
            };
      });
      this.streams.set(streamId, created);
      this.streamsByTab.set(tabKey, created);
      stream = created;
    }

    const viewer: Viewer = {
      sink: input.sink,
      stream,
      ready: false,
      inFlight: 0,
      lastSentAt: 0,
      pending: null,
    };
    stream.viewers.set(input.sink.id, viewer);
    this.viewers.set(input.sink.id, viewer);

    const started = await stream.started;
    if (!started.ok) {
      this.removeStream(stream, false);
      return started;
    }
    if (!stream.viewers.has(input.sink.id)) {
      return {
        ok: false,
        error: { code: "browser_tab_closed", message: "The browser stream ended." },
      };
    }
    return { ok: true, page: stream.page };
  }

  /** Called after the subscription response is on the wire, so frames never precede it. */
  activateViewer(viewerId: string): void {
    const viewer = this.viewers.get(viewerId);
    if (!viewer || viewer.ready) return;
    viewer.ready = true;
    if (viewer.stream.latestFrame) this.offerFrame(viewer, viewer.stream.latestFrame);
  }

  removeViewer(viewerId: string): void {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) return;
    this.viewers.delete(viewerId);
    const stream = viewer.stream;
    stream.viewers.delete(viewerId);
    if (stream.viewers.size === 0) this.removeStream(stream, true);
  }

  ackViewerFrame(viewerId: string): void {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) return;
    viewer.inFlight = Math.max(0, viewer.inFlight - 1);
    const pending = viewer.pending;
    if (pending) {
      viewer.pending = null;
      this.offerFrame(viewer, pending);
    }
  }

  async sendInput(viewerId: string, input: BrowserScreencastInput): Promise<HostReply> {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) {
      return {
        ok: false,
        error: { code: "browser_tab_closed", message: "The browser stream ended." },
      };
    }
    const { stream } = viewer;
    const channel = this.hosts.getScreencastChannel(stream.hostId);
    if (!channel) {
      return {
        ok: false,
        error: { code: "browser_no_host", message: "The desktop app disconnected." },
      };
    }
    return this.requestHost(stream.hostId, (requestId) =>
      channel.send({
        type: "browser.host.screencast.input.request",
        requestId,
        streamId: stream.streamId,
        input,
      }),
    );
  }

  hasViewer(viewerId: string): boolean {
    return this.viewers.has(viewerId);
  }

  receiveHostFrame(
    frame: BrowserScreencastFrame,
    bytes: Uint8Array,
    hostIds: readonly string[],
  ): boolean {
    const stream = this.streams.get(frame.id);
    if (!stream || !hostIds.includes(stream.hostId)) return false;
    this.hosts.getScreencastChannel(stream.hostId)?.send({
      type: "browser.host.screencast.ack_frame.request",
      streamId: stream.streamId,
      sequence: frame.sequence,
    });
    stream.latestFrame = bytes;
    for (const viewer of stream.viewers.values()) {
      if (viewer.ready) this.offerFrame(viewer, bytes);
    }
    return true;
  }

  receiveHostReport(
    report: {
      streamId: string;
      event:
        | { kind: "page"; page: BrowserScreencastPageState }
        | { kind: "ended"; error: BrowserScreencastError };
    },
    hostIds: readonly string[],
  ): boolean {
    const stream = this.streams.get(report.streamId);
    if (!stream || !hostIds.includes(stream.hostId)) return false;
    if (report.event.kind === "page") {
      stream.page = report.event.page;
      for (const viewer of stream.viewers.values()) viewer.sink.sendPage(report.event.page);
      return true;
    }
    this.endStream(stream, report.event.error, false);
    return true;
  }

  receiveHostReply(
    payload: { requestId: string } & HostReply,
    hostIds: readonly string[],
  ): boolean {
    const pending = this.pending.get(payload.requestId);
    if (!pending || !hostIds.includes(pending.hostId)) return false;
    this.pending.delete(payload.requestId);
    clearTimeout(pending.timeout);
    pending.resolve({
      ok: payload.ok,
      ...(payload.page ? { page: payload.page } : {}),
      ...(payload.error ? { error: payload.error } : {}),
    });
    return true;
  }

  getStreamCount(): number {
    return this.streams.size;
  }

  private offerFrame(viewer: Viewer, bytes: Uint8Array): void {
    const now = this.now();
    if (
      viewer.inFlight >= VIEWER_FRAME_WINDOW &&
      now - viewer.lastSentAt > VIEWER_CREDIT_RESET_MS
    ) {
      viewer.inFlight = 0;
    }
    if (viewer.inFlight >= VIEWER_FRAME_WINDOW) {
      viewer.pending = bytes;
      return;
    }
    viewer.inFlight += 1;
    viewer.lastSentAt = now;
    viewer.sink.sendFrame(readdressBrowserScreencastFrame(bytes, viewer.sink.id));
  }

  private requestHost(hostId: string, send: (requestId: string) => void): Promise<HostReply> {
    const requestId = `screencast_${randomUUID()}`;
    return new Promise<HostReply>((resolve) => {
      const fail = (error: BrowserScreencastError) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.resolve({ ok: false, error });
      };
      const timeout = setTimeout(
        () =>
          fail({ code: "browser_timeout", message: "The desktop app did not respond in time." }),
        this.hostRequestTimeoutMs,
      );
      this.pending.set(requestId, { hostId, timeout, resolve });
      try {
        send(requestId);
      } catch (error) {
        fail({
          code: "browser_unknown_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private handleHostGone(hostId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.hostId !== hostId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve({
        ok: false,
        error: { code: "browser_no_host", message: "The desktop app disconnected." },
      });
    }
    for (const stream of Array.from(this.streams.values())) {
      if (stream.hostId !== hostId) continue;
      this.endStream(
        stream,
        { code: "browser_no_host", message: "The desktop app disconnected." },
        false,
      );
    }
  }

  private endStream(stream: HostStream, error: BrowserScreencastError, notifyHost: boolean): void {
    const viewers = [...stream.viewers.values()];
    this.removeStream(stream, notifyHost);
    for (const viewer of viewers) {
      if (viewer.ready) viewer.sink.end(error);
    }
  }

  private removeStream(stream: HostStream, notifyHost: boolean): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    this.streams.delete(stream.streamId);
    this.streamsByTab.delete(`${stream.hostId}\u0000${stream.browserId}`);
    for (const viewerId of stream.viewers.keys()) this.viewers.delete(viewerId);
    stream.viewers.clear();
    if (notifyHost) {
      this.hosts.getScreencastChannel(stream.hostId)?.send({
        type: "browser.host.screencast.stop.request",
        streamId: stream.streamId,
      });
    }
  }
}
