import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { prepareRenderDocument, type RenderTheme } from "@getpaseo/protocol/html-render";
import { startPublicPreviewProxy } from "./public-proxy.js";
import { previewBrowserHostDiagnostic } from "./browser-host.js";

const PAGE_URL = "http://paseo-page.localhost/page.html";
const VIEWPORT_HEIGHT = 800;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_HEIGHT = 4000;
const MAX_CONSOLE_MESSAGES = 20;
const execFileAsync = promisify(execFile);

export interface PreviewConsoleMessage {
  level: "log" | "info" | "warning" | "error";
  text: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

class CdpPipe {
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly frames = new CdpFrameDecoder();
  private listeners = new Set<(message: CdpMessage) => void>();
  private failure: Error | null = null;

  constructor(private readonly child: ChildProcess) {
    const reader = child.stdio[4];
    if (!reader || !("on" in reader)) throw new Error("Preview browser CDP pipe is unavailable");
    reader.on("data", (chunk: Buffer) => {
      try {
        for (const raw of this.frames.push(chunk)) {
          this.receive(JSON.parse(raw) as CdpMessage);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid preview browser response"));
      }
    });
    reader.on("error", (error) => this.fail(error));
    reader.on("close", () => this.fail(new Error("Preview browser exited")));
    child.on("error", (error) => this.fail(error));
    child.on("exit", () => this.fail(new Error("Preview browser exited")));
  }

  private receive(message: CdpMessage): void {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (waiter) {
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result ?? {});
      }
    } else for (const listener of this.listeners) listener(message);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  onEvent(listener: (message: CdpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    const writer = this.child.stdio[3];
    if (!writer || !("write" in writer))
      return Promise.reject(new Error("Preview browser CDP pipe is unavailable"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writer.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
        (error: Error | null | undefined) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }

  post(method: string, params: Record<string, unknown>, sessionId: string): void {
    void this.send(method, params, sessionId).catch(() => undefined);
  }
}

export class CdpFrameDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > 14 * 1024 * 1024) throw new Error("screenshot_too_large");
    const frames: string[] = [];
    let end = this.buffer.indexOf("\0");
    while (end >= 0) {
      frames.push(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
      end = this.buffer.indexOf("\0");
    }
    return frames;
  }
}

let activeBrowsers = 0;
const waiters: (() => void)[] = [];
async function acquireBrowser(waitMs: number, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new Error("Preview cancelled");
  if (activeBrowsers >= 2)
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const index = waiters.indexOf(wake);
        if (index >= 0) waiters.splice(index, 1);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(new Error("Preview cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Preview browser is busy"));
      }, waitMs);
      waiters.push(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  else activeBrowsers++;
  return () => {
    const next = waiters.shift();
    if (next) next();
    else activeBrowsers--;
  };
}

async function withBrowser<T>(
  executable: string,
  task: (cdp: CdpPipe) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const started = Date.now();
  const release = await acquireBrowser(timeoutMs, signal);
  let scratch: string | null = null;
  let child: ChildProcess | null = null;
  let proxy: Awaited<ReturnType<typeof startPublicPreviewProxy>> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stderrTail = "";
  let onAbort: (() => void) | null = null;
  try {
    scratch = await mkdtemp(path.join(tmpdir(), "paseo-html-preview-"));
    proxy = await startPublicPreviewProxy();
    child = spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--block-new-web-contents",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--dns-prefetch-disable",
        "--js-flags=--max-old-space-size=256",
        `--proxy-server=socks5://127.0.0.1:${proxy.port}`,
        "--proxy-bypass-list=<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ...(process.env.PASEO_PREVIEW_BROWSER_SANDBOX === "0" ? ["--no-sandbox"] : []),
        `--user-data-dir=${path.join(scratch, "profile")}`,
        "about:blank",
      ],
      {
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      },
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2048);
    });
    const cdp = new CdpPipe(child);
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Preview browser timed out")), remaining);
    });
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Preview cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    return await Promise.race([
      cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).then(() => task(cdp)),
      timeout,
      cancellation,
    ]);
  } catch (error) {
    const diagnostic = await previewBrowserHostDiagnostic(executable, stderrTail);
    if (diagnostic) throw new Error(diagnostic, { cause: error });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (child?.pid) {
      if (process.platform === "win32") {
        await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          timeout: 3000,
        }).catch(() => child?.kill("SIGKILL"));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      if (child.exitCode === null)
        await new Promise<void>((resolve) => {
          child!.once("exit", () => resolve());
          setTimeout(resolve, 2000).unref();
        });
    }
    try {
      await proxy?.close();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}

function consoleMessageFromEvent(event: CdpMessage): PreviewConsoleMessage | null {
  let level: PreviewConsoleMessage["level"];
  let text: string;
  if (event.method === "Runtime.consoleAPICalled") {
    const kind = String(event.params?.type);
    if (kind === "warn" || kind === "warning") level = "warning";
    else if (kind === "error" || kind === "assert") level = "error";
    else if (kind === "info") level = "info";
    else level = "log";
    text = Array.isArray(event.params?.args)
      ? event.params.args
          .map((arg) => String(record(arg).value ?? record(arg).description ?? ""))
          .join(" ")
      : "";
  } else if (event.method === "Runtime.exceptionThrown") {
    level = "error";
    const details = record(event.params?.exceptionDetails);
    text = String(record(details.exception).description ?? details.text ?? "Exception");
  } else if (event.method === "Log.entryAdded") {
    const entry = record(event.params?.entry);
    if (entry.level !== "warning" && entry.level !== "error") return null;
    level = entry.level;
    text = String(entry.text ?? "");
  } else return null;
  return { level, text: text.replaceAll(PAGE_URL, "page.html").slice(0, 500) };
}

async function openPage(
  cdp: CdpPipe,
  width: number,
  html: string,
): Promise<{
  height: number;
  sessionId: string;
  targetId: string;
  messages: PreviewConsoleMessage[];
  close: () => Promise<void>;
}> {
  const targetId = String((await cdp.send("Target.createTarget", { url: "about:blank" })).targetId);
  const sessionId = String(
    (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId,
  );
  const messages: PreviewConsoleMessage[] = [];
  let omitted = 0;
  let resolveLoad: (() => void) | null = null;
  const loaded = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });
  const off = cdp.onEvent((event) => {
    if (event.sessionId !== sessionId || !event.method) return;
    if (event.method === "Page.loadEventFired") {
      resolveLoad?.();
      return;
    }
    if (event.method === "Fetch.requestPaused") {
      const params = record(event.params);
      const requestId = String(params.requestId);
      const url = String(record(params.request).url).split("#", 1)[0];
      if (url === PAGE_URL && params.resourceType === "Document" && params.frameId === targetId) {
        cdp.post(
          "Fetch.fulfillRequest",
          {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
            body: Buffer.from(html, "utf8").toString("base64"),
          },
          sessionId,
        );
      } else cdp.post("Fetch.failRequest", { requestId, errorReason: "AccessDenied" }, sessionId);
      return;
    }
    const message = consoleMessageFromEvent(event);
    if (message) {
      if (messages.length < MAX_CONSOLE_MESSAGES) messages.push(message);
      else omitted++;
    }
  });
  const close = async () => {
    off();
    if (omitted)
      messages.push({ level: "warning", text: `${omitted} more console messages were omitted.` });
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  };
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    await cdp.send("Network.setBypassServiceWorker", { bypass: true }, sessionId);
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source:
          "Object.defineProperty(window,'RTCPeerConnection',{value:undefined,configurable:false});Object.defineProperty(window,'webkitRTCPeerConnection',{value:undefined,configurable:false});",
      },
      sessionId,
    );
    await cdp.send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: "http://paseo-page.localhost/*" },
          { urlPattern: "*", resourceType: "Document" },
        ],
      },
      sessionId,
    );
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const navigation = await cdp.send("Page.navigate", { url: PAGE_URL }, sessionId);
    if (navigation.errorText) throw new Error("Preview page navigation failed");
    await loaded;
    await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
        awaitPromise: true,
      },
      sessionId,
    );
    const result = await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          "(() => { const b=document.body; return b ? Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)) : 0; })()",
        returnByValue: true,
      },
      sessionId,
    );
    const height = Number(record(result.result).value);
    if (!Number.isInteger(height) || height < 0 || height > 100_000)
      throw new Error("Preview page height is invalid");
    return { height: Math.max(1, height), sessionId, targetId, messages, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function documentForPreview(html: string, theme: RenderTheme): string {
  return prepareRenderDocument({
    html,
    theme,
    nonce: "preview",
    renderId: "preview",
    linkMode: "web",
  });
}

export async function captureHtmlPreview(input: {
  executable: string;
  html: string;
  width: number;
  theme: RenderTheme;
  signal?: AbortSignal;
}): Promise<{
  png: string;
  contentHeight: number;
  capturedHeight: number;
  consoleMessages: PreviewConsoleMessage[];
}> {
  const html = documentForPreview(input.html, input.theme);
  return withBrowser(
    input.executable,
    async (cdp) => {
      const page = await openPage(cdp, input.width, html);
      try {
        const capturedHeight = Math.min(page.height, MAX_CAPTURE_HEIGHT);
        const result = await cdp.send(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: input.width, height: capturedHeight, scale: 1 },
          },
          page.sessionId,
        );
        const png = String(result.data ?? "");
        if (
          !png ||
          png.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) ||
          Buffer.from(png, "base64").length > MAX_PNG_BYTES
        )
          throw new Error("screenshot_too_large");
        return { png, contentHeight: page.height, capturedHeight, consoleMessages: page.messages };
      } finally {
        await page.close();
      }
    },
    20_000,
    input.signal,
  );
}

export async function measureHtmlRenderHeights(input: {
  executable: string;
  html: string;
  widths: readonly number[];
  theme: RenderTheme;
  signal?: AbortSignal;
}): Promise<[number, number][]> {
  const html = documentForPreview(input.html, input.theme);
  return withBrowser(
    input.executable,
    async (cdp) => {
      const result: [number, number][] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, input.widths.length) }, async () => {
          for (;;) {
            const index = next++;
            if (index >= input.widths.length) break;
            const width = input.widths[index]!;
            const page = await openPage(cdp, width, html);
            result[index] = [width, page.height];
            await page.close();
          }
        }),
      );
      return result;
    },
    6000,
    input.signal,
  );
}
