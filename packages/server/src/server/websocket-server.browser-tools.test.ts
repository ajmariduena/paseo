import { createServer, type Server as HTTPServer } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  BrowserAutomationCommandName,
  BrowserAutomationExecuteRequest,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BROWSER_AUTOMATION_COMMAND_NAMES } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  encodeBrowserScreencastFrame,
  type BrowserScreencastFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { ScheduleService } from "./schedule/service.js";
import { createStub } from "./test-utils/class-mocks.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

interface BrowserToolsDaemonHarness {
  broker: BrowserToolsBroker;
  url: string;
  track(client: DaemonClient): void;
  connectBrowserHostClient(
    options?: ConnectBrowserHostClientOptions,
  ): Promise<BrowserHostClientHandle>;
  stop(): Promise<void>;
}

interface ConnectBrowserHostClientOptions {
  clientId?: string;
  capabilities?: Record<string, unknown>;
}

interface BrowserHostClientHandle {
  clientId: string;
  nextBrowserRequest(): Promise<BrowserAutomationExecuteRequest>;
  respondToBrowserRequest(response: BrowserAutomationExecuteResponse): void;
  disconnect(): Promise<void>;
}

interface QueuedBrowserRequests {
  next(): Promise<BrowserAutomationExecuteRequest>;
  push(request: BrowserAutomationExecuteRequest): void;
  close(): void;
}

const harnesses: BrowserToolsDaemonHarness[] = [];
const BROWSER_ID = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
});

function browserHostCapabilities(
  supportedCommands: readonly BrowserAutomationCommandName[] = BROWSER_AUTOMATION_COMMAND_NAMES,
): Record<string, unknown> {
  return {
    [CLIENT_CAPS.browserHost]: {
      supportedCommands: [...supportedCommands],
      hostKind: "desktop app",
    },
  };
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

describe("WebSocketServer browser tools wiring", () => {
  it("registers capable clients and dispatches broker requests over the real WebSocket path", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient();

    const resultPromise = harness.broker.execute({
      command: { command: "list_tabs", args: {} },
    });
    const request = await browserHost.nextBrowserRequest();

    expect(request).toMatchObject({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      command: { command: "list_tabs", args: {} },
    });

    browserHost.respondToBrowserRequest({
      type: "browser.automation.execute.response",
      payload: {
        requestId: request.requestId,
        ok: true,
        result: { command: "list_tabs", tabs: [] },
      },
    });

    await expect(resultPromise).resolves.toEqual({
      requestId: request.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
  });

  it("unregisters capable clients on disconnect and clears pending browser commands", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient();

    const pendingResult = harness.broker.execute({
      command: { command: "list_tabs", args: {} },
    });
    const pendingExpectation = expect(pendingResult).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true },
    });
    await browserHost.nextBrowserRequest();

    expect(harness.broker.getPendingRequestCount()).toBe(1);

    await browserHost.disconnect();

    expect(harness.broker.getRegisteredClientCount()).toBe(0);
    expect(harness.broker.getPendingRequestCount()).toBe(0);
    await pendingExpectation;

    await expect(
      harness.broker.execute({ command: { command: "list_tabs", args: {} } }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host" },
    });
  });

  it("keeps browser automation registered when a browser host client resumes", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const clientId = "browser-host-client-1";
    const originalBrowserHost = await harness.connectBrowserHostClient({
      clientId,
      capabilities: browserHostCapabilities(),
    });
    await originalBrowserHost.disconnect();

    const resumedBrowserHost = await harness.connectBrowserHostClient({
      clientId,
      capabilities: browserHostCapabilities(),
    });

    const resultPromise = harness.broker.execute({
      command: { command: "click", args: { browserId: BROWSER_ID, ref: "@e1" } },
    });
    const request = await resumedBrowserHost.nextBrowserRequest();
    resumedBrowserHost.respondToBrowserRequest({
      type: "browser.automation.execute.response",
      payload: {
        requestId: request.requestId,
        ok: true,
        result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
    });
  });

  it("clears pending browser commands when a browser host changes capabilities", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const clientId = "browser-host-client-1";
    const browserHost = await harness.connectBrowserHostClient({
      clientId,
      capabilities: browserHostCapabilities(),
    });

    const pendingResult = harness.broker.execute({
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
    });
    await browserHost.nextBrowserRequest();
    expect(harness.broker.getPendingRequestCount()).toBe(1);

    await browserHost.disconnect();
    await harness.connectBrowserHostClient({
      clientId,
      capabilities: browserHostCapabilities(["list_tabs"]),
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true },
    });
    expect(harness.broker.getRegisteredClientCount()).toBe(1);
    expect(harness.broker.getPendingRequestCount()).toBe(0);
  });
});

const WORKSPACE_ID = "workspace-1";
const PAGE = {
  url: "https://example.com/",
  title: "Example",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

interface ScreencastHost {
  client: DaemonClient;
  next<T extends SessionOutboundMessage["type"]>(
    type: T,
  ): Promise<Extract<SessionOutboundMessage, { type: T }>>;
  disconnect(): Promise<void>;
}

async function connectScreencastHost(harness: BrowserToolsDaemonHarness): Promise<ScreencastHost> {
  const client = new DaemonClient({
    url: harness.url,
    clientType: "browser",
    connectTimeoutMs: 500,
    reconnect: { enabled: false },
  });
  harness.track(client);
  await client.connect();
  const received: SessionOutboundMessage[] = [];
  const waiters = new Set<() => void>();
  const observation = client.registerBrowserHost({
    hostKind: "desktop app",
    supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
    screencast: true,
  });
  observation.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type === "browser.automation.execute.request") {
        client.sendBrowserAutomationExecuteResponse({
          type: "browser.automation.execute.response",
          payload: {
            requestId: message.requestId,
            ok: true,
            result: {
              command: "list_tabs",
              tabs: [
                {
                  browserId: BROWSER_ID,
                  workspaceId: WORKSPACE_ID,
                  url: PAGE.url,
                  title: PAGE.title,
                  isActive: true,
                  isLoading: false,
                },
              ],
            },
          },
        });
        return;
      }
      received.push(message);
      for (const wake of waiters) wake();
    },
  });
  await observation.ready;
  return {
    client,
    async next(type) {
      const startedAt = Date.now();
      for (;;) {
        const index = received.findIndex((message) => message.type === type);
        if (index !== -1) {
          return received.splice(index, 1)[0] as never;
        }
        if (Date.now() - startedAt > 1_000) throw new Error(`Timed out waiting for ${type}`);
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
          setTimeout(wake, 20);
        });
      }
    },
    async disconnect() {
      await client.close();
      await waitFor(() => harness.broker.getRegisteredClientCount() === 0);
    },
  };
}

async function connectViewer(harness: BrowserToolsDaemonHarness): Promise<DaemonClient> {
  const viewer = new DaemonClient({
    url: harness.url,
    clientType: "mobile",
    connectTimeoutMs: 500,
    reconnect: { enabled: false },
  });
  harness.track(viewer);
  await viewer.connect();
  return viewer;
}

function hostFrame(streamId: string, sequence: number): Uint8Array {
  return encodeBrowserScreencastFrame({
    id: streamId,
    sequence,
    format: "jpeg",
    snapshot: false,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
    image: new Uint8Array([0xff, 0xd8, sequence]),
  });
}

describe("WebSocketServer browser screencast", () => {
  it("streams a desktop tab to a viewer and routes its input back to the host", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const host = await connectScreencastHost(harness);
    const viewer = await connectViewer(harness);

    expect(viewer.supportsBrowserScreencast()).toBe(true);
    await expect(viewer.listBrowserHosts()).resolves.toEqual([
      { hostId: expect.any(String), hostKind: "desktop app", screencast: true },
    ]);

    const frames: BrowserScreencastFrame[] = [];
    viewer.onBrowserScreencastFrame((frame) => frames.push(frame));
    const updates: SessionOutboundMessage[] = [];
    const observation = viewer.observeBrowserScreencast({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: { maxWidth: 800, maxHeight: 800 },
    });
    observation.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });

    const start = await host.next("browser.host.screencast.start.request");
    expect(start).toMatchObject({ browserId: BROWSER_ID, workspaceId: WORKSPACE_ID });
    host.client.sendBrowserScreencastHostMessage({
      type: "browser.host.screencast.start.response",
      payload: { requestId: start.requestId, ok: true, page: PAGE },
    });
    const snapshot = await observation.ready;
    expect(snapshot.page).toEqual(PAGE);

    host.client.sendBrowserScreencastHostFrame(hostFrame(start.streamId, 1));
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ id: snapshot.subscriptionId, sequence: 1 });
    await expect(host.next("browser.host.screencast.ack_frame.request")).resolves.toMatchObject({
      streamId: start.streamId,
      sequence: 1,
    });

    const reply = viewer.sendBrowserScreencastInput(snapshot.subscriptionId, {
      kind: "click",
      x: 10,
      y: 20,
    });
    const input = await host.next("browser.host.screencast.input.request");
    expect(input).toMatchObject({
      streamId: start.streamId,
      input: { kind: "click", x: 10, y: 20 },
    });
    host.client.sendBrowserScreencastHostMessage({
      type: "browser.host.screencast.input.response",
      payload: { requestId: input.requestId, ok: true },
    });
    await expect(reply).resolves.toMatchObject({ ok: true });

    host.client.sendBrowserScreencastHostMessage({
      type: "browser.host.screencast.report.request",
      streamId: start.streamId,
      event: { kind: "page", page: { ...PAGE, title: "Next" } },
    });
    await waitFor(() => updates.length === 1);
    expect(updates[0]).toMatchObject({
      type: "browser.remote.screencast.update",
      payload: { event: { kind: "page", page: { title: "Next" } } },
    });

    await observation.release();
    await expect(host.next("browser.host.screencast.stop.request")).resolves.toMatchObject({
      streamId: start.streamId,
    });
  });

  it("ends the viewer's stream when the desktop host disconnects", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const host = await connectScreencastHost(harness);
    const viewer = await connectViewer(harness);
    const updates: SessionOutboundMessage[] = [];
    const observation = viewer.observeBrowserScreencast({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: { maxWidth: 800, maxHeight: 800 },
    });
    observation.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });
    const start = await host.next("browser.host.screencast.start.request");
    host.client.sendBrowserScreencastHostMessage({
      type: "browser.host.screencast.start.response",
      payload: { requestId: start.requestId, ok: true, page: PAGE },
    });
    await observation.ready;

    await host.disconnect();

    await waitFor(() => updates.length === 1);
    expect(updates[0]).toMatchObject({
      type: "browser.remote.screencast.update",
      payload: { event: { kind: "ended", error: { code: "browser_no_host" } } },
    });
  });

  it("rejects a remote command for a tab when no desktop host is connected", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const viewer = await connectViewer(harness);
    await expect(
      viewer.executeBrowserRemoteCommand({
        workspaceId: WORKSPACE_ID,
        command: { command: "new_tab", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_no_host" } });
    const observation = viewer.observeBrowserScreencast({
      workspaceId: WORKSPACE_ID,
      browserId: BROWSER_ID,
      capture: { maxWidth: 800, maxHeight: 800 },
    });
    await expect(observation.ready).rejects.toMatchObject({ code: "browser_no_host" });
  });
});

async function startBrowserToolsDaemonHarness(): Promise<BrowserToolsDaemonHarness> {
  const httpServer = createServer();
  const broker = createBroker();
  const wsServer = createVoiceAssistantWebSocketServer({ httpServer, broker });
  const clients = new Set<DaemonClient>();

  await listen(httpServer);
  const url = `ws://127.0.0.1:${getPort(httpServer)}/ws`;

  const harness: BrowserToolsDaemonHarness = {
    broker,
    url,
    track: (client) => clients.add(client),
    async connectBrowserHostClient(options = {}) {
      const clientId = options.clientId;
      const client = new DaemonClient({
        url,
        ...(clientId ? { clientId } : {}),
        clientType: "browser",
        connectTimeoutMs: 500,
        reconnect: { enabled: false },
        capabilities: options.capabilities ?? browserHostCapabilities(),
      });
      clients.add(client);

      const requests = createBrowserRequestQueue();
      client.on("browser.automation.execute.request", (request) => {
        requests.push(request);
      });

      await client.connect();
      const capability = (options.capabilities ?? browserHostCapabilities())[
        CLIENT_CAPS.browserHost
      ] as { hostKind: "desktop app"; supportedCommands: BrowserAutomationCommandName[] };
      const observation = client.registerBrowserHost(capability);
      await observation.ready;

      return {
        clientId: clientId ?? "",
        nextBrowserRequest: () => requests.next(),
        respondToBrowserRequest: (response) =>
          client.sendBrowserAutomationExecuteResponse(response),
        async disconnect() {
          await observation.release();
          requests.close();
          clients.delete(client);
          await client.close();
          await waitFor(() => broker.getRegisteredClientCount() === 0);
        },
      };
    },
    async stop() {
      await Promise.all(Array.from(clients, (client) => client.close()));
      clients.clear();
      await wsServer.close();
      await closeHttpServer(httpServer);
    },
  };

  harnesses.push(harness);
  return harness;
}

function createBroker(): BrowserToolsBroker {
  return new BrowserToolsBroker({
    defaultTimeoutMs: 500,
    createRequestId: createRequestIdSequence(),
  });
}

function createRequestIdSequence(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `req-${index}`;
  };
}

function createVoiceAssistantWebSocketServer(params: {
  httpServer: HTTPServer;
  broker: BrowserToolsBroker;
}): VoiceAssistantWebSocketServer {
  const { httpServer, broker } = params;
  const agentManager = {
    setAgentAttentionCallback() {},
    subscribe: () => () => {},
    getMetricsSnapshot: () => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: { totalItems: 0, maxItemsPerAgent: 0 },
    }),
  };
  const daemonConfigStore = {
    onApply: () => () => {},
    onChange: () => () => {},
  };

  return new VoiceAssistantWebSocketServer(
    httpServer,
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-browser-tools-websocket-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set(["*"]) },
    createWorkspaceAutoNameStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: () => {},
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
    undefined,
    undefined,
    broker,
  );
}

function createBrowserRequestQueue(): QueuedBrowserRequests {
  const requests: BrowserAutomationExecuteRequest[] = [];
  const waiters: Array<{
    resolve: (request: BrowserAutomationExecuteRequest) => void;
    reject: (error: Error) => void;
  }> = [];
  let closed = false;

  return {
    next() {
      const request = requests.shift();
      if (request) {
        return Promise.resolve(request);
      }
      if (closed) {
        return Promise.reject(new Error("Desktop browser client disconnected"));
      }
      return new Promise<BrowserAutomationExecuteRequest>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        const waiter = {
          resolve: (value: BrowserAutomationExecuteRequest) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          },
        };
        timeout = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex !== -1) {
            waiters.splice(waiterIndex, 1);
          }
          reject(new Error("Timed out waiting for browser automation request"));
        }, 500);
        waiters.push(waiter);
      });
    },
    push(request) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(request);
        return;
      }
      requests.push(request);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error("Desktop browser client disconnected"));
      }
    },
  };
}

function createLogger() {
  const logger = {
    child: () => logger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return logger;
}

function listen(server: HTTPServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function getPort(server: HTTPServer): number {
  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error("HTTP test server did not bind to a TCP port");
  }
  return address.port;
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === "object" && address !== null && typeof address.port === "number";
}

function closeHttpServer(server: HTTPServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 500) {
      throw new Error("Timed out waiting for browser tools WebSocket state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
