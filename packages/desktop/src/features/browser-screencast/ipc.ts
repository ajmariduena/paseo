import { ipcMain, type WebContents } from "electron";
import {
  BrowserScreencastCaptureSchema,
  BrowserScreencastInputSchema,
  type BrowserScreencastError,
  type BrowserScreencastInput,
  type BrowserScreencastPageState,
} from "@getpaseo/protocol/browser-screencast/rpc-schemas";
import { isBrowserScreencastId } from "@getpaseo/protocol/binary-frames/index";
import {
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWorkspaceId,
} from "../browser-webviews/index.js";
import { adaptWebContents } from "../browser-automation/ipc.js";
import {
  dispatchTrustedClick,
  dispatchTrustedScroll,
} from "../browser-automation/trusted-input.js";
import type { CdpCommandSender } from "../browser-automation/cdp-session-queue.js";
import { BrowserScreencastStream, type ScreencastGuest } from "./stream.js";

export const BROWSER_SCREENCAST_FRAME_CHANNEL = "paseo:browser:screencast:frame";
export const BROWSER_SCREENCAST_EVENT_CHANNEL = "paseo:browser:screencast:event";

interface ActiveStream {
  hostContentsId: number;
  browserId: string;
  stream: BrowserScreencastStream;
}

const streams = new Map<string, ActiveStream>();

type StartResult =
  | { ok: true; page: BrowserScreencastPageState }
  | { ok: false; error: BrowserScreencastError };

export function registerBrowserScreencastIpc(): void {
  ipcMain.handle("paseo:browser:screencast:start", (event, raw: unknown) =>
    startStream(event.sender, raw),
  );
  ipcMain.handle("paseo:browser:screencast:stop", async (event, streamId: unknown) => {
    const active = ownedStream(event.sender, streamId);
    if (!active) return;
    streams.delete(active.stream.streamId);
    await active.stream.stop();
  });
  ipcMain.on("paseo:browser:screencast:ack", (event, streamId: unknown) => {
    ownedStream(event.sender, streamId)?.stream.ack();
  });
  ipcMain.handle("paseo:browser:screencast:input", (event, streamId: unknown, raw: unknown) =>
    dispatchInput(event.sender, streamId, raw),
  );
}

async function startStream(host: WebContents, raw: unknown): Promise<StartResult> {
  const request = readStartRequest(raw);
  if (!request) {
    return {
      ok: false,
      error: { code: "browser_unsupported", message: "Invalid stream request." },
    };
  }
  const guest = getPaseoBrowserWebContentsForHostWindow(request.browserId, host.id);
  if (!guest || getPaseoBrowserWorkspaceId(request.browserId) !== request.workspaceId) {
    return {
      ok: false,
      error: { code: "browser_tab_not_found", message: "No browser tab found for that ID." },
    };
  }
  const existing = streams.get(request.streamId);
  if (existing) {
    streams.delete(request.streamId);
    await existing.stream.stop();
  }
  const stream = new BrowserScreencastStream(
    request.streamId,
    createScreencastGuest(guest),
    request.capture,
    {
      frame: (bytes) => {
        if (!host.isDestroyed())
          host.send(BROWSER_SCREENCAST_FRAME_CHANNEL, request.streamId, bytes);
      },
      page: (page) => {
        if (!host.isDestroyed())
          host.send(BROWSER_SCREENCAST_EVENT_CHANNEL, request.streamId, { kind: "page", page });
      },
      ended: (error) => {
        streams.delete(request.streamId);
        if (!host.isDestroyed())
          host.send(BROWSER_SCREENCAST_EVENT_CHANNEL, request.streamId, { kind: "ended", error });
      },
    },
  );
  streams.set(request.streamId, { hostContentsId: host.id, browserId: request.browserId, stream });
  host.once("destroyed", () => {
    if (streams.get(request.streamId)?.stream !== stream) return;
    streams.delete(request.streamId);
    void stream.stop();
  });
  try {
    return { ok: true, page: await stream.start() };
  } catch (error) {
    streams.delete(request.streamId);
    return {
      ok: false,
      error: {
        code: "browser_unknown_error",
        message: error instanceof Error ? error.message : "Could not start the browser stream.",
      },
    };
  }
}

async function dispatchInput(
  host: WebContents,
  streamId: unknown,
  raw: unknown,
): Promise<{ ok: boolean; error?: BrowserScreencastError }> {
  const active = ownedStream(host, streamId);
  const parsed = BrowserScreencastInputSchema.safeParse(raw);
  if (!active || !parsed.success) {
    return {
      ok: false,
      error: { code: "browser_tab_closed", message: "The browser stream ended." },
    };
  }
  const guest = getPaseoBrowserWebContentsForHostWindow(active.browserId, host.id);
  if (!guest) {
    return { ok: false, error: { code: "browser_tab_closed", message: "The browser tab closed." } };
  }
  try {
    if (parsed.data.kind === "viewport")
      await active.stream.setViewport(parsed.data.mobile ?? null);
    else await sendInput(guest, parsed.data);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "browser_unknown_error",
        message: error instanceof Error ? error.message : "Browser input failed.",
      },
    };
  }
}

async function sendInput(
  guest: WebContents,
  input: Exclude<BrowserScreencastInput, { kind: "viewport" }>,
): Promise<void> {
  const tab = adaptWebContents(guest);
  const send = tab.sendDebugCommand;
  if (!send) throw new Error("Browser input is unavailable.");
  switch (input.kind) {
    case "click":
      await dispatchTrustedClick(send, { x: input.x, y: input.y }, { button: input.button });
      return;
    case "wheel":
      await dispatchTrustedScroll(send, { x: input.x, y: input.y }, input.deltaX, input.deltaY);
      return;
    case "text":
      // CDP Input.insertText commits into the focused element of the whole Paseo window.
      await guest.insertText(input.text);
      return;
    case "key":
      await dispatchNamedKey(send, input.key);
      return;
  }
}

const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", keyCode: 9, text: "\t" },
  Escape: { code: "Escape", keyCode: 27 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
};

// A keyDown with text produces the keypress that submits forms; without text it is a rawKeyDown.
async function dispatchNamedKey(send: CdpCommandSender, key: string): Promise<void> {
  const named = NAMED_KEYS[key];
  if (!named) throw new Error(`Unsupported key: ${key}`);
  const base = { key, code: named.code, windowsVirtualKeyCode: named.keyCode };
  await send("Input.dispatchKeyEvent", {
    ...base,
    type: named.text ? "keyDown" : "rawKeyDown",
    ...(named.text ? { text: named.text, unmodifiedText: named.text } : {}),
  });
  await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

function ownedStream(host: WebContents, streamId: unknown): ActiveStream | null {
  if (typeof streamId !== "string") return null;
  const active = streams.get(streamId);
  return active && active.hostContentsId === host.id ? active : null;
}

function readStartRequest(raw: unknown) {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const capture = BrowserScreencastCaptureSchema.safeParse(record.capture);
  if (
    typeof record.streamId !== "string" ||
    !isBrowserScreencastId(record.streamId) ||
    typeof record.browserId !== "string" ||
    typeof record.workspaceId !== "string" ||
    !capture.success
  ) {
    return null;
  }
  return {
    streamId: record.streamId,
    browserId: record.browserId,
    workspaceId: record.workspaceId,
    capture: capture.data,
  };
}

function createScreencastGuest(contents: WebContents): ScreencastGuest {
  const debuggerApi = contents.debugger;
  let expectedDetaches = 0;
  const ensureAttached = () => {
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
  };
  return {
    isDestroyed: () => contents.isDestroyed(),
    sendCommand: async (method, params) => {
      ensureAttached();
      try {
        return await debuggerApi.sendCommand(method, params ?? {});
      } catch (error) {
        // A guest that navigated across processes leaves the debugger on the old page.
        if (
          !(error instanceof Error) ||
          !error.message.includes("Not attached to an active page")
        ) {
          throw error;
        }
        expectedDetaches += 1;
        debuggerApi.detach();
        debuggerApi.attach("1.3");
        return debuggerApi.sendCommand(method, params ?? {});
      }
    },
    onDebuggerMessage: (listener) => {
      const handler = (_event: unknown, method: string, params: unknown) =>
        listener(method, (params ?? {}) as Record<string, unknown>);
      debuggerApi.on("message", handler);
      return () => debuggerApi.removeListener("message", handler);
    },
    onDebuggerDetach: (listener) => {
      const handler = () => {
        if (expectedDetaches > 0) {
          expectedDetaches -= 1;
          return;
        }
        listener();
      };
      debuggerApi.on("detach", handler);
      return () => debuggerApi.removeListener("detach", handler);
    },
    onPageStateChange: (listener) => {
      const events = [
        "did-navigate",
        "did-navigate-in-page",
        "page-title-updated",
        "did-start-loading",
        "did-stop-loading",
      ] as const;
      for (const name of events) contents.on(name as "did-stop-loading", listener);
      return () => {
        for (const name of events) contents.removeListener(name as "did-stop-loading", listener);
      };
    },
    onNavigated: (listener) => {
      contents.on("did-navigate", listener);
      return () => contents.removeListener("did-navigate", listener);
    },
    onDestroyed: (listener) => {
      contents.once("destroyed", listener);
      return () => contents.removeListener("destroyed", listener);
    },
    readPageState: () => ({
      url: contents.getURL().slice(0, 8192),
      title: contents.getTitle().slice(0, 1024),
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    }),
    invalidate: () => contents.invalidate(),
    getBackgroundThrottling: () => contents.getBackgroundThrottling(),
    setBackgroundThrottling: (allowed) => contents.setBackgroundThrottling(allowed),
  };
}
