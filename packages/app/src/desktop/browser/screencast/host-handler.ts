import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { DesktopBrowserScreencastBridge } from "@/desktop/host";

type HostScreencastRequest = Extract<
  SessionOutboundMessage,
  {
    type:
      | "browser.host.screencast.start.request"
      | "browser.host.screencast.stop.request"
      | "browser.host.screencast.ack_frame.request"
      | "browser.host.screencast.input.request";
  }
>;

type HostScreencastReply = Extract<
  SessionInboundMessage,
  {
    type:
      | "browser.host.screencast.start.response"
      | "browser.host.screencast.input.response"
      | "browser.host.screencast.report.request";
  }
>;

export interface BrowserScreencastHostClient {
  sendBrowserScreencastHostFrame(frame: Uint8Array): void;
  sendBrowserScreencastHostMessage(message: HostScreencastReply): void;
}

export function isHostScreencastRequest(
  message: SessionOutboundMessage,
): message is HostScreencastRequest {
  return (
    message.type === "browser.host.screencast.start.request" ||
    message.type === "browser.host.screencast.stop.request" ||
    message.type === "browser.host.screencast.ack_frame.request" ||
    message.type === "browser.host.screencast.input.request"
  );
}

export interface BrowserScreencastHostHandler {
  handle(message: HostScreencastRequest): void;
  /** The daemon forgets every stream when the host registration is replaced. */
  reset(): void;
  dispose(): void;
}

export function createBrowserScreencastHostHandler(input: {
  client: BrowserScreencastHostClient;
  bridge: DesktopBrowserScreencastBridge;
  /** Creates the guest of a saved tab that has not been shown yet; false when there is none. */
  prepareGuest?: (input: {
    browserId: string;
    workspaceId: string;
    requestId: string;
  }) => Promise<boolean>;
  /** Sizes the guest for a viewer's mobile view; null restores the desktop's viewport. */
  sizeGuest?: (browserId: string, size: { width: number; height: number } | null) => void;
}): BrowserScreencastHostHandler {
  const { client, bridge, prepareGuest, sizeGuest } = input;
  const active = new Set<string>();
  const browserByStream = new Map<string, string>();
  const sizedStreams = new Set<string>();
  const restoreSize = (streamId: string) => {
    const browserId = browserByStream.get(streamId);
    browserByStream.delete(streamId);
    if (sizedStreams.delete(streamId) && browserId) sizeGuest?.(browserId, null);
  };
  const send = (message: HostScreencastReply) => {
    try {
      client.sendBrowserScreencastHostMessage(message);
    } catch (error) {
      console.warn("[browser-screencast] Failed to reach the daemon", error);
    }
  };
  const stop = (streamId: string) => {
    restoreSize(streamId);
    if (!active.delete(streamId)) return;
    void bridge.stop(streamId).catch(() => {});
  };

  const disposeFrames = bridge.onFrame((streamId, frame) => {
    if (!active.has(streamId)) return;
    try {
      client.sendBrowserScreencastHostFrame(frame);
    } catch {
      // A frame lost to a reconnect is replaced by the next one.
    }
  });
  const disposeEvents = bridge.onEvent((streamId, event) => {
    if (!active.has(streamId)) return;
    if (event.kind === "ended") {
      active.delete(streamId);
      restoreSize(streamId);
    }
    send({ type: "browser.host.screencast.report.request", streamId, event });
  });

  const start = async (
    message: Extract<HostScreencastRequest, { type: "browser.host.screencast.start.request" }>,
  ) => {
    active.add(message.streamId);
    browserByStream.set(message.streamId, message.browserId);
    const request = {
      streamId: message.streamId,
      browserId: message.browserId,
      workspaceId: message.workspaceId,
      capture: message.capture,
    };
    const result = await bridge
      .start(request)
      .then(async (first) => {
        if (first.ok || first.error.code !== "browser_tab_not_found" || !prepareGuest) return first;
        const prepared = await prepareGuest({
          browserId: message.browserId,
          workspaceId: message.workspaceId,
          requestId: message.requestId,
        });
        return prepared ? bridge.start(request) : first;
      })
      .catch((error: unknown) => ({
        ok: false as const,
        error: {
          code: "browser_unknown_error" as const,
          message: error instanceof Error ? error.message : "Could not start the browser stream.",
        },
      }));
    if (!result.ok) {
      active.delete(message.streamId);
      browserByStream.delete(message.streamId);
    }
    send({
      type: "browser.host.screencast.start.response",
      payload: result.ok
        ? { requestId: message.requestId, ok: true, page: result.page }
        : { requestId: message.requestId, ok: false, error: result.error },
    });
  };

  const forwardInput = async (
    message: Extract<HostScreencastRequest, { type: "browser.host.screencast.input.request" }>,
  ) => {
    const browserId = browserByStream.get(message.streamId);
    if (message.input.kind === "viewport" && browserId && active.has(message.streamId)) {
      const mobile = message.input.mobile;
      if (mobile) sizedStreams.add(message.streamId);
      else sizedStreams.delete(message.streamId);
      sizeGuest?.(browserId, mobile ? { width: mobile.width, height: mobile.height } : null);
    }
    const result = active.has(message.streamId)
      ? await bridge.input(message.streamId, message.input).catch((error: unknown) => ({
          ok: false,
          error: {
            code: "browser_unknown_error" as const,
            message: error instanceof Error ? error.message : "Browser input failed.",
          },
        }))
      : {
          ok: false,
          error: { code: "browser_tab_closed" as const, message: "The browser stream ended." },
        };
    send({
      type: "browser.host.screencast.input.response",
      payload: {
        requestId: message.requestId,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      },
    });
  };

  return {
    handle: (message) => {
      switch (message.type) {
        case "browser.host.screencast.start.request":
          void start(message);
          return;
        case "browser.host.screencast.stop.request":
          stop(message.streamId);
          return;
        case "browser.host.screencast.ack_frame.request":
          if (active.has(message.streamId)) bridge.ack(message.streamId);
          return;
        case "browser.host.screencast.input.request":
          void forwardInput(message);
          return;
      }
    },
    reset: () => {
      for (const streamId of Array.from(active)) stop(streamId);
    },
    dispose: () => {
      disposeFrames();
      disposeEvents();
      for (const streamId of Array.from(active)) stop(streamId);
    },
  };
}
