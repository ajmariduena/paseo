import { afterEach, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";
import { HandoffOwnership } from "../server/handoff/ownership.js";
import type {
  TerminalActivityTransitionEvent,
  TerminalManager,
  TerminalWorkspaceContributionChangedEvent,
} from "./terminal-manager.js";
import {
  resolvePaseoCliBinDir,
  resolvePaseoCliExecutablePath,
  type TerminalSession,
} from "./terminal.js";
import type { TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";

type TerminalRow = TerminalState["grid"][number];

function nodeTerminalCommand(script: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", script],
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function getVisibleText(session: TerminalSession): string {
  return getVisibleTextFromState(session.getState());
}

function rowToText(row: TerminalRow): string {
  return row
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
}

function getVisibleTextFromState(state: TerminalState): string {
  return state.grid.map(rowToText).join("\n");
}

function getRenderedTextFromState(state: TerminalState): string {
  return [...state.scrollback, ...state.grid].map(rowToText).join("\n");
}

function readRenderedTokenIndexesFromState(state: TerminalState): number[] {
  const indexes: number[] = [];
  for (const match of getRenderedTextFromState(state).matchAll(/\[(\d+)\]/g)) {
    const value = match[1];
    if (value !== undefined) {
      indexes.push(Number(value));
    }
  }
  return indexes;
}

function createTerminalState(): TerminalState {
  const blankCell = { char: " " };
  return {
    rows: 1,
    cols: 1,
    grid: [[blankCell]],
    scrollback: [],
    cursor: { row: 0, col: 0 },
  };
}

class FakeTerminalWorker extends EventEmitter {
  connected = true;
  killed = false;
  readonly sentMessages: TerminalWorkerRequest[] = [];
  onRequest: ((request: TerminalWorkerRequest) => void) | null = null;

  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean {
    this.sentMessages.push(message);
    callback(null);
    this.onRequest?.(message);
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.emit("exit", 0, null);
  }

  kill(): boolean {
    this.killed = true;
    this.connected = false;
    this.emit("exit", 0, null);
    return true;
  }

  emitWorkerMessage(message: TerminalWorkerToParentMessage): void {
    this.emit("message", message);
  }
}

let manager: TerminalManager | null = null;
const temporaryDirs: string[] = [];
const terminalSessions: TerminalSession[] = [];

function trackTerminal(session: TerminalSession): TerminalSession {
  terminalSessions.push(session);
  return session;
}

async function removeTemporaryDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

afterEach(async () => {
  const sessions = terminalSessions.splice(0);
  await Promise.all(
    sessions.map((session) =>
      session
        .killAndWait({
          gracefulTimeoutMs: 1000,
          forceTimeoutMs: 500,
        })
        .catch(() => {}),
    ),
  );
  manager?.killAll();
  manager = null;
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) {
      await removeTemporaryDir(dir);
    }
  }
});

async function handoffFixture() {
  const root = mkdtempSync(join(tmpdir(), "terminal-handoff-"));
  temporaryDirs.push(root);
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const ownership = new HandoffOwnership({
    directory: join(root, "ownership"),
    sourceServerId: "source-host",
  });
  await ownership.initialize();
  const transfer = {
    id: randomUUID(),
    cwd,
    workspaceId: "ws-test",
    agentIds: [],
    destinationServerId: "target-host",
    reservationId: randomUUID(),
  };
  return { cwd, ownership, transfer };
}

function completeWorkerCreation(worker: FakeTerminalWorker, request: TerminalWorkerRequest) {
  if (request.type !== "createTerminal" || !request.options.id)
    throw new Error("Expected creation request");
  const terminal = {
    id: request.options.id,
    cwd: request.options.cwd,
    workspaceId: request.options.workspaceId,
    name: "Shell",
    activity: null,
  };
  worker.emitWorkerMessage({ type: "terminalCreated", terminal, state: createTerminalState() });
  worker.emitWorkerMessage({
    type: "response",
    requestId: request.requestId,
    ok: true,
    result: { terminal, state: createTerminalState() },
  });
  return terminal.id;
}

it("handoff: refuses terminal creation before sending a request to the worker", async () => {
  const { cwd, ownership, transfer } = await handoffFixture();
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    forkWorker: () => worker,
    requestTimeoutMs: 10,
    handoffOwnership: ownership,
  });
  await ownership.prepare(transfer);
  await expect(
    manager.createTerminal({ cwd, workspaceId: "another-workspace" }),
  ).rejects.toMatchObject({ code: "fenced" });
  expect(worker.sentMessages).toEqual([]);
});

it("handoff: holds terminal creation through registration and worker settlement, then fences input and resize", async () => {
  const { cwd, ownership, transfer } = await handoffFixture();
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({ forkWorker: () => worker, handoffOwnership: ownership });
  const creating = manager.createTerminal({ cwd, workspaceId: "ws-test" });
  await waitForCondition(() => worker.sentMessages.length === 1, 1000);
  const request = worker.sentMessages[0];
  await ownership.prepare(transfer);
  await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
    code: "invalid_state",
  });
  const id = completeWorkerCreation(worker, request);
  const session = await creating;
  expect(manager.getTerminal(id)).toBe(session);
  await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
    code: "invalid_state",
  });
  worker.emitWorkerMessage({ type: "terminalCreateSettled", terminalId: id });
  await ownership.drain(transfer.id);
  expect((await ownership.markReady(transfer.id, "a".repeat(64))).state).toBe("ready");
  expect(() => session.send({ type: "input", data: "touch unsafe\r" })).toThrow(
    "Workspace is held by handoff",
  );
  expect(() => session.send({ type: "resize", rows: 50, cols: 100 })).toThrow(
    "Workspace is held by handoff",
  );
  expect(session.getSize()).toEqual({ rows: 1, cols: 1 });
  expect(worker.sentMessages.map((message) => message.type)).toEqual(["createTerminal"]);
  expect((await manager.getTerminals(cwd)).map((terminal) => terminal.id)).toEqual([id]);
  await ownership.cancel(transfer.id);
  session.send({ type: "input", data: "echo resumed\r" });
  expect(worker.sentMessages.at(-1)).toMatchObject({
    type: "send",
    message: { type: "input", data: "echo resumed\r" },
  });
});

it.each(["timeout", "early worker error"])(
  "handoff: keeps a %s creation leased until the worker settles it",
  async (failure) => {
    const { cwd, ownership, transfer } = await handoffFixture();
    const worker = new FakeTerminalWorker();
    manager = createWorkerTerminalManager({
      forkWorker: () => worker,
      handoffOwnership: ownership,
      requestTimeoutMs: 50,
    });
    const creating = manager.createTerminal({ cwd, workspaceId: "ws-test" });
    const rejected = expect(creating).rejects.toThrow(
      failure === "timeout" ? "timed out" : "conpty failure",
    );
    await waitForCondition(() => worker.sentMessages.length === 1, 1000, 1);
    const request = worker.sentMessages[0];
    if (failure === "early worker error")
      worker.emitWorkerMessage({
        type: "response",
        requestId: request.requestId,
        ok: false,
        error: "conpty failure",
      });
    await rejected;
    await ownership.prepare(transfer);
    await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
      code: "invalid_state",
    });
    const id = completeWorkerCreation(worker, request);
    const session = manager.getTerminal(id);
    if (!session) throw new Error("Late terminal was not registered");
    expect(session.id).toBe(id);
    expect(() => session.send({ type: "input", data: "unsafe\r" })).toThrow(
      "Workspace is held by handoff",
    );
    worker.emitWorkerMessage({ type: "terminalCreateSettled", terminalId: id });
    await ownership.drain(transfer.id);
    expect((await ownership.markReady(transfer.id, "a".repeat(64))).state).toBe("ready");
  },
);

it("handoff: keeps timed-out input leased until a late worker acknowledgement", async () => {
  const { cwd, ownership, transfer } = await handoffFixture();
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    forkWorker: () => worker,
    handoffOwnership: ownership,
    requestTimeoutMs: 20,
  });
  worker.onRequest = (request) => {
    if (request.type !== "createTerminal") return;
    const terminalId = completeWorkerCreation(worker, request);
    worker.emitWorkerMessage({ type: "terminalCreateSettled", terminalId });
  };
  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  const id = session.id;
  session.send({ type: "input", data: "admitted\r" });
  const input = worker.sentMessages.at(-1);
  if (!input || input.type !== "send") throw new Error("Expected input request");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await ownership.prepare(transfer);
  await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
    code: "invalid_state",
  });
  worker.emitWorkerMessage({ type: "response", requestId: input.requestId, ok: true });
  await ownership.drain(transfer.id);
  expect((await ownership.markReady(transfer.id, "a".repeat(64))).state).toBe("ready");
  const stopping = manager.killTerminalAndWait(id);
  const stop = worker.sentMessages.at(-1);
  if (!stop || stop.type !== "killTerminalAndWait") throw new Error("Expected stop request");
  worker.emitWorkerMessage({ type: "response", requestId: stop.requestId, ok: true });
  await stopping;
});

it("handoff: a worker exit cannot certify that an admitted creation never started", async () => {
  const { cwd, ownership, transfer } = await handoffFixture();
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({ forkWorker: () => worker, handoffOwnership: ownership });
  const creating = manager.createTerminal({ cwd, workspaceId: "ws-test" });
  const rejected = expect(creating).rejects.toThrow("Terminal worker exited");
  await waitForCondition(() => worker.sentMessages.length === 1, 1000, 1);
  worker.kill();
  await rejected;
  await ownership.prepare(transfer);
  await expect(ownership.markReady(transfer.id, "a".repeat(64))).rejects.toMatchObject({
    code: "invalid_state",
  });
});

it("handoff: fences a real worker terminal and permits input again after cancellation", async () => {
  const { cwd, ownership, transfer } = await handoffFixture();
  const marker = join(cwd, "input.txt");
  manager = createWorkerTerminalManager({ handoffOwnership: ownership });
  const session = trackTerminal(
    await manager.createTerminal({
      cwd,
      workspaceId: "ws-test",
      ...nodeTerminalCommand(`
      const fs = require("node:fs");
      const startup = setInterval(() => {
        if (!fs.existsSync("start.txt")) return;
        clearInterval(startup);
        process.stdin.on("data", () => fs.writeFileSync("input.txt", "resumed"));
        process.stdout.write("handoff-ready");
        setInterval(() => {}, 1000);
      }, 10);
    `),
    }),
  );
  // Start output after registration so readiness cannot come from the creation snapshot.
  writeFileSync(join(cwd, "start.txt"), "start");
  await waitForCondition(async () => {
    const snapshot = await manager!.getTerminalState(session.id);
    return snapshot !== null && getVisibleTextFromState(snapshot.state).includes("handoff-ready");
  }, 10000);
  await ownership.prepare(transfer);
  expect(() => session.send({ type: "input", data: "blocked\r" })).toThrow(
    "Workspace is held by handoff",
  );
  expect(existsSync(marker)).toBe(false);
  await ownership.cancel(transfer.id);
  session.send({ type: "input", data: "continue\r" });
  await waitForCondition(() => existsSync(marker), 10000);
  expect(readFileSync(marker, "utf8")).toBe("resumed");
});

it("handoff: real worker validation failure settles admission without starting a terminal", async () => {
  const { cwd, ownership, transfer } = await handoffFixture();
  manager = createWorkerTerminalManager({ handoffOwnership: ownership });
  await expect(
    manager.createTerminal({
      cwd,
      workspaceId: "",
    }),
  ).rejects.toThrow("workspaceId is required");
  await ownership.prepare(transfer);
  await ownership.drain(transfer.id);
  expect((await ownership.markReady(transfer.id, "a".repeat(64))).state).toBe("ready");
  expect(await manager.getTerminals(cwd)).toEqual([]);
});

it("creates a terminal through the worker and streams output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-output-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand(`
      process.stdin.on("data", (chunk) => {
        process.stdout.write("worker-output:" + chunk.toString());
      });
      setInterval(() => {}, 1000);
    `),
    }),
  );
  const messages: string[] = [];
  let snapshots = 0;
  const unsubscribe = session.subscribe((message) => {
    if (message.type === "output") {
      messages.push(message.data);
    }
    if (message.type === "snapshot") {
      snapshots += 1;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const snapshotsBeforeOutput = snapshots;

  session.send({ type: "input", data: "hello\r" });

  await waitForCondition(
    () =>
      messages.join("").includes("worker-output:hello") ||
      getVisibleText(session).includes("worker-output:hello"),
    10000,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  unsubscribe();

  expect(messages.join("") + getVisibleText(session)).toContain("worker-output:hello");
  expect(snapshots).toBe(snapshotsBeforeOutput);
});

it("delivers rapid small writes complete and in order through worker coalescing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-coalesce-"));
  temporaryDirs.push(cwd);
  const burstGatePath = join(cwd, "burst-ready");
  manager = createWorkerTerminalManager();
  // The file gate starts the burst after this test subscribes without depending
  // on platform-specific PTY input echo/canonical-mode behavior.
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      env: { PASEO_TERMINAL_BURST_GATE: burstGatePath },
      ...nodeTerminalCommand(`
      const fs = require("node:fs");
      const gatePath = process.env.PASEO_TERMINAL_BURST_GATE;
      const gate = setInterval(() => {
        if (!gatePath || !fs.existsSync(gatePath)) {
          return;
        }
        clearInterval(gate);
        for (let i = 0; i < 500; i++) {
          process.stdout.write("[" + i + "]\\n");
        }
      }, 10);
      setInterval(() => {}, 1000);
    `),
    }),
  );

  const events: Array<{ type: string; data?: string }> = [];
  session.subscribe((message) => {
    if (message.type === "output") {
      events.push({ type: "output", data: message.data });
    } else if (message.type === "snapshot" || message.type === "snapshotReady") {
      events.push({ type: message.type });
    }
  });

  // Let the snapshot subscription settle, then trigger the burst.
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(burstGatePath, "go");

  const expected = Array.from({ length: 500 }, (_, index) => index);
  let received: number[] = [];
  await waitForCondition(async () => {
    const snapshot = await manager!.getTerminalState(session.id);
    received = snapshot ? readRenderedTokenIndexesFromState(snapshot.state) : [];
    return expected.every((value, index) => received[index] === value);
  }, 10000);

  expect(received).toEqual(expected);

  await waitForCondition(() => events.some((event) => event.type === "output"), 10000);

  // No snapshot may land after output it should have preceded: every snapshot
  // event must come before the first output event.
  const firstOutputIndex = events.findIndex((event) => event.type === "output");
  expect(firstOutputIndex).toBeGreaterThanOrEqual(0);
  const snapshotAfterOutput = events
    .slice(firstOutputIndex + 1)
    .find((event) => event.type === "snapshot" || event.type === "snapshotReady");
  expect(snapshotAfterOutput).toBeUndefined();
});

it("pulls fresh terminal state from the worker authority", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-state-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand(`
      process.stdout.write("worker-state-ready\\n");
      setInterval(() => {}, 1000);
    `),
    }),
  );

  let visibleText = "";
  await waitForCondition(async () => {
    const snapshot = await manager!.getTerminalState(session.id);
    visibleText = snapshot ? getVisibleTextFromState(snapshot.state) : "";
    return visibleText.includes("worker-state-ready");
  }, 10000);

  expect(visibleText).toContain("worker-state-ready");
});

// Windows ConPTY normalizes away the kitty keyboard escape the child writes, so it
// never reaches the worker's input-mode tracker and the preamble stays empty. The
// preamble-caching contract is verified on Linux/macOS; the daemon's input-mode
// handling runs identically on every platform once the escape is observed.
it.skipIf(isPlatform("win32"))(
  "caches the input-mode replay preamble from the worker after getTerminalState",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-preamble-"));
    temporaryDirs.push(cwd);
    manager = createWorkerTerminalManager();
    // \x1b[>1u pushes kitty keyboard flag 1, which the worker's input-mode
    // tracker records and reflects in its replay preamble (\x1b[=1;1u).
    const session = trackTerminal(
      await manager.createTerminal({
        workspaceId: "ws-test",
        cwd,
        ...nodeTerminalCommand(`
      process.stdout.write("\\u001b[>1u");
      setInterval(() => {}, 1000);
    `),
      }),
    );

    await waitForCondition(async () => {
      const snapshot = await manager!.getTerminalState(session.id);
      return snapshot !== null && session.getReplayPreamble() === "\x1b[=1;1u";
    }, 10000);

    expect(session.getReplayPreamble()).toBe("\x1b[=1;1u");
  },
);

it("refreshes cached terminal title after worker title changes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-title-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand(`
      process.stdout.write("\\u001b]0;Build Output\\u0007");
      setTimeout(() => {}, 2000);
    `),
    }),
  );

  await waitForCondition(() => session.getTitle() === "Build Output", 10000);

  expect(session.getState().title).toBe("Build Output");
});

it("refreshes cached terminal size after worker resize", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-resize-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(await manager.createTerminal({ cwd, workspaceId: "ws-test" }));

  session.send({ type: "resize", rows: 10, cols: 40 });
  const snapshot = await manager.getTerminalState(session.id);

  expect(snapshot?.state.rows).toBe(10);
  expect(snapshot?.state.cols).toBe(40);
  expect(session.getState().rows).toBe(10);
  expect(session.getState().cols).toBe(40);
});

it("captures terminal output from the worker authority", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-capture-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(await manager.createTerminal({ cwd, workspaceId: "ws-test" }));

  session.send({ type: "input", data: "echo hello world\r" });

  let capture = await manager.captureTerminal(session.id);
  await waitForCondition(async () => {
    capture = await manager!.captureTerminal(session.id);
    return capture.lines.join("\n").includes("hello world");
  }, 10000);

  expect(capture.lines.join("\n")).toContain("hello world");
  expect(capture.totalLines).toBeGreaterThan(0);
});

it("does not surface fire-and-forget send timeouts as unhandled rejections", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 5,
    forkWorker: () => worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-1",
      name: "Terminal",
      cwd: "/tmp",
      workspaceId: "ws-test",
      activity: { state: "idle", changedAt: 0 },
    },
    state: createTerminalState(),
  });
  const session = manager.getTerminal("terminal-1");
  expect(session).toBeDefined();

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    session?.send({ type: "input", data: "x" });
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  expect(worker.sentMessages.some((message) => message.type === "send")).toBe(true);
  expect(unhandledRejections).toEqual([]);
});

it("keeps registered cwd env inheritance behind the worker manager interface", async () => {
  manager = createWorkerTerminalManager();
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-env-"));
  temporaryDirs.push(cwd);
  const markerPath = join(cwd, "env.txt");

  manager.registerCwdEnv({
    cwd,
    env: { PASEO_WORKER_TERMINAL_TEST: "worker-env" },
  });
  trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand(`
      require("node:fs").writeFileSync(
        ${JSON.stringify(markerPath)},
        process.env.PASEO_WORKER_TERMINAL_TEST ?? "",
      );
      setInterval(() => {}, 1000);
    `),
    }),
  );

  await waitForCondition(() => existsSync(markerPath), 10000);

  expect(readFileSync(markerPath, "utf8")).toBe("worker-env");
});

it("injects parent-minted terminal activity env through the worker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-activity-env-"));
  temporaryDirs.push(cwd);
  const envPath = join(cwd, "activity-env.json");
  const activityUrl = "http://127.0.0.1:12345/api/terminal-activity";
  manager = createWorkerTerminalManager({
    getTerminalActivityUrl: () => activityUrl,
  });

  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand(`
        require("node:fs").writeFileSync(
          ${JSON.stringify(envPath)},
          JSON.stringify({
            terminalId: process.env.PASEO_TERMINAL_ID,
            token: process.env.PASEO_ACTIVITY_TOKEN,
            url: process.env.PASEO_TERMINAL_ACTIVITY_URL,
            hookCli: process.env.PASEO_HOOK_CLI,
            path: process.env.PATH ?? process.env.Path,
          }),
        );
        setInterval(() => {}, 1000);
      `),
    }),
  );

  await waitForCondition(() => existsSync(envPath), 10000);

  const env = JSON.parse(readFileSync(envPath, "utf8")) as {
    terminalId?: string;
    token?: string;
    url?: string;
    hookCli?: string;
    path?: string;
  };
  const paseoCliBinDir = resolvePaseoCliBinDir();
  const paseoCliPath = resolvePaseoCliExecutablePath();
  expect(paseoCliBinDir).not.toBeNull();
  expect(paseoCliPath).not.toBeNull();
  expect(env.terminalId).toBe(session.id);
  expect(env.token).toEqual(expect.any(String));
  expect(env.token).not.toBe("");
  expect(env.url).toBe(activityUrl);
  expect(env.hookCli).toBe(paseoCliPath);
  expect(manager.validateTerminalActivityToken(session.id, env.token ?? "")).toBe("valid");
  await expect(manager.setTerminalActivity(session.id, "attention")).resolves.toBe(true);
  expect(env.path?.split(delimiter)[0]).toBe(paseoCliBinDir);
});

it("starts the default shell through the worker and accepts quoted commands", async () => {
  manager = createWorkerTerminalManager();
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-shell-"));
  temporaryDirs.push(cwd);
  const markerPath = join(cwd, "shell quoted marker.txt");
  const session = trackTerminal(await manager.createTerminal({ cwd, workspaceId: "ws-test" }));
  const command = [
    "node",
    "-e",
    `"require('node:fs').writeFileSync('shell quoted marker.txt','shell-ok')"`,
  ].join(" ");

  session.send({ type: "input", data: `${command}\r` });

  await expect.poll(() => readFileSync(markerPath, "utf8"), { timeout: 10000 }).toBe("shell-ok");
});

it("lists subdirectory terminals when querying the workspace root", async () => {
  const rootCwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-subdir-root-"));
  const subdirCwd = join(rootCwd, "apps", "mobile");
  mkdirSync(subdirCwd, { recursive: true });
  temporaryDirs.push(rootCwd);
  manager = createWorkerTerminalManager();
  const created = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd: subdirCwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
    }),
  );

  const rootTerminals = await manager.getTerminals(rootCwd);

  expect(rootTerminals.map((terminal) => terminal.id)).toEqual([created.id]);
});

it("lists terminals locally without waiting on the worker", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 5,
    forkWorker: () => worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-root",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: { state: "idle", changedAt: 0 },
    },
    state: createTerminalState(),
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-subdir",
      name: "Shell",
      cwd: "/workspace/apps/mobile",
      workspaceId: "ws-test",
      activity: { state: "idle", changedAt: 0 },
    },
    state: createTerminalState(),
  });

  // The fake worker never answers requests, so a round-trip would reject at the
  // 5ms timeout. A local mirror read must resolve regardless.
  const terminals = await manager.getTerminals("/workspace");

  expect(terminals.map((terminal) => terminal.id).sort()).toEqual([
    "terminal-root",
    "terminal-subdir",
  ]);
  expect(worker.sentMessages.some((message) => message.type === "getTerminals")).toBe(false);
});

it("includes only stamped terminals in workspace-scoped local reads", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 5,
    forkWorker: () => worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-legacy",
      name: "Legacy",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-owned",
      name: "Owned",
      cwd: "/workspace",
      workspaceId: "ws-owned",
      activity: null,
    },
    state: createTerminalState(),
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-sibling",
      name: "Sibling",
      cwd: "/workspace",
      workspaceId: "ws-sibling",
      activity: null,
    },
    state: createTerminalState(),
  });

  const scoped = await manager.getTerminals("/workspace", { workspaceId: "ws-owned" });
  const unscoped = await manager.getTerminals("/workspace");

  expect(scoped.map((terminal) => terminal.id)).toEqual(["terminal-owned"]);
  expect(unscoped.map((terminal) => terminal.id)).toEqual([
    "terminal-legacy",
    "terminal-owned",
    "terminal-sibling",
  ]);
});

it("rejects non-absolute cwd in getTerminals", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 5,
    forkWorker: () => worker,
  });

  await expect(manager.getTerminals("relative/path")).rejects.toThrow("cwd must be absolute path");
});

it("surfaces worker activity changes via getActivity, onActivityChange, and terminalsChanged", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    forkWorker: () => worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: { state: "idle", changedAt: 0 },
    },
    state: createTerminalState(),
  });

  const session = manager.getTerminal("terminal-a");
  expect(session).toBeDefined();
  expect(session!.getActivity()).toEqual({ state: "idle", changedAt: 0 });

  const activityChanges: Array<{
    activity: TerminalActivity | null;
    previous: TerminalActivity | null;
  }> = [];
  const activityTransitions: TerminalActivityTransitionEvent[] = [];
  const terminalsChangedCwds: string[] = [];
  session!.onActivityChange((transition) => {
    activityChanges.push(transition);
  });
  manager.subscribeTerminalActivity((event) => {
    activityTransitions.push(event);
  });
  manager.subscribeTerminalsChanged((event) => {
    terminalsChangedCwds.push(event.cwd);
  });

  const workingActivity = { state: "working" as const, changedAt: 1000 };
  const idleActivity = { state: "idle" as const, changedAt: 0 };
  worker.emitWorkerMessage({
    type: "terminalActivityChange",
    terminalId: "terminal-a",
    activity: workingActivity,
    previous: idleActivity,
  });

  expect(session!.getActivity()).toEqual(workingActivity);
  expect(activityChanges).toEqual([{ activity: workingActivity, previous: idleActivity }]);
  expect(activityTransitions).toEqual([
    {
      terminalId: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: workingActivity,
      previous: idleActivity,
    },
  ]);
  expect(terminalsChangedCwds).toContain("/workspace");
});

it("sets terminal activity through a worker request", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    forkWorker: () => worker,
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });

  const result = manager.setTerminalActivity("terminal-a", "attention");
  const request = worker.sentMessages.find((message) => message.type === "setActivity");
  expect(request).toMatchObject({
    type: "setActivity",
    terminalId: "terminal-a",
    state: "attention",
  });
  if (!request) {
    throw new Error("setActivity request not sent");
  }
  worker.emitWorkerMessage({ type: "response", requestId: request.requestId, ok: true });

  await expect(result).resolves.toBe(true);
});

it("clears terminal attention through a worker request", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    forkWorker: () => worker,
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: { state: "idle", attentionReason: "finished", changedAt: 1000 },
    },
    state: createTerminalState(),
  });

  const result = manager.clearTerminalAttention("terminal-a");
  const request = worker.sentMessages.find((message) => message.type === "clearAttention");
  expect(request).toMatchObject({
    type: "clearAttention",
    terminalId: "terminal-a",
  });
  if (!request) {
    throw new Error("attention clear request not sent");
  }
  worker.emitWorkerMessage({ type: "response", requestId: request.requestId, ok: true });

  await expect(result).resolves.toBe(true);
});

it("clears finished attention on a real terminal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-attention-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
    }),
  );

  // A working -> idle transition is how the real tracker records a "finished"
  // attention: { state: "idle", attentionReason: "finished" }. The state is
  // never literally "attention", so a clear that checks state === "attention"
  // would never fire — the bug this reproduces.
  await manager.setTerminalActivity(session.id, "working");
  await manager.setTerminalActivity(session.id, "idle");
  await waitForCondition(
    () => manager?.getTerminal(session.id)?.getActivity()?.attentionReason === "finished",
    5000,
  );

  const cleared = await manager.clearTerminalAttention(session.id);

  expect(cleared).toBe(true);
  await waitForCondition(
    () => manager?.getTerminal(session.id)?.getActivity()?.attentionReason == null,
    5000,
  );
  expect(manager.getTerminal(session.id)?.getActivity()).toEqual({
    state: "idle",
    changedAt: expect.any(Number),
  });
});

it("removes worker terminals after killAndWait", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-kill-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
    }),
  );

  await manager.killTerminalAndWait(session.id, {
    gracefulTimeoutMs: 1000,
    forceTimeoutMs: 500,
  });
  terminalSessions.splice(terminalSessions.indexOf(session), 1);

  await waitForCondition(() => manager?.getTerminal(session.id) === undefined, 5000);

  expect(manager.getTerminal(session.id)).toBeUndefined();
  expect(manager.listDirectories()).not.toContain(cwd);
});

it.skipIf(isPlatform("win32"))(
  "handoff: confirms forced exit of a real terminal process that ignores hangup",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-force-stop-"));
    temporaryDirs.push(cwd);
    const readyPath = join(cwd, "ready");
    manager = createWorkerTerminalManager();
    const session = trackTerminal(
      await manager.createTerminal({
        workspaceId: "ws-test",
        cwd,
        ...nodeTerminalCommand(`
      process.on("SIGHUP", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, String(process.pid) + "\\n");
      setInterval(() => {}, 1000);
    `),
      }),
    );
    await waitForCondition(
      () => existsSync(readyPath) && readFileSync(readyPath, "utf8").endsWith("\n"),
      10000,
    );
    const pid = Number(readFileSync(readyPath, "utf8").trim());
    await manager.killTerminalAndWait(session.id, { gracefulTimeoutMs: 25, forceTimeoutMs: 2000 });
    expect(session.getExitInfo()?.signal).toBe(9);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(manager.getTerminal(session.id)).toBeUndefined();
  },
);

it("handoff: keeps worker terminals observable after a failed stop and allows a confirmed retry", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({ forkWorker: () => worker, requestTimeoutMs: 50 });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "still-running",
      name: "Shell",
      cwd: tmpdir(),
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });
  const stopping = manager.killTerminalAndWait("still-running");
  const failedRequest = worker.sentMessages.at(-1);
  if (!failedRequest) throw new Error("Missing stop request");
  worker.emitWorkerMessage({
    type: "response",
    requestId: failedRequest.requestId,
    ok: false,
    error: "Terminal process did not exit: still-running",
  });
  await expect(stopping).rejects.toThrow("Terminal process did not exit");
  expect(manager.getTerminal("still-running")?.id).toBe("still-running");
  expect((await manager.getTerminals(tmpdir())).map((terminal) => terminal.id)).toEqual([
    "still-running",
  ]);

  const retry = manager.killTerminalAndWait("still-running");
  const retryRequest = worker.sentMessages.at(-1);
  if (!retryRequest) throw new Error("Missing retry request");
  worker.emitWorkerMessage({
    type: "terminalExit",
    terminalId: "still-running",
    info: { exitCode: 0, signal: null, lastOutputLines: [] },
  });
  worker.emitWorkerMessage({ type: "response", requestId: retryRequest.requestId, ok: true });
  await retry;
  expect(manager.getTerminal("still-running")).toBeUndefined();
});

it("produces one terminals-changed snapshot per title change", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    forkWorker: () => worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });

  const snapshots: Array<{ cwd: string; terminalIds: string[] }> = [];
  manager.subscribeTerminalsChanged((event) => {
    snapshots.push({ cwd: event.cwd, terminalIds: event.terminals.map((t) => t.id) });
  });

  worker.emitWorkerMessage({
    type: "terminalTitleChange",
    terminalId: "terminal-a",
    title: "Updated",
  });

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toEqual({
    cwd: "/workspace",
    terminalIds: ["terminal-a"],
  });
});

it("produces one terminals-changed snapshot and one contribution event per activity change", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    forkWorker: () => worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });

  const snapshots: Array<{ cwd: string; terminalIds: string[] }> = [];
  manager.subscribeTerminalsChanged((event) => {
    snapshots.push({ cwd: event.cwd, terminalIds: event.terminals.map((t) => t.id) });
  });
  const contributions: TerminalWorkspaceContributionChangedEvent[] = [];
  manager.subscribeTerminalWorkspaceContributionChanged((event) => {
    contributions.push(event);
  });

  const workingActivity = { state: "working" as const, changedAt: 1000 };
  worker.emitWorkerMessage({
    type: "terminalActivityChange",
    terminalId: "terminal-a",
    activity: workingActivity,
    previous: null,
  });

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toEqual({
    cwd: "/workspace",
    terminalIds: ["terminal-a"],
  });
  expect(contributions).toEqual([
    {
      terminalId: "terminal-a",
      cwd: "/workspace",
      workspaceId: "ws-test",
    },
  ]);
});

it("removes a killed worker terminal from terminalExit without duplicate snapshots", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    forkWorker: () => worker,
  });
  const workingActivity = { state: "working" as const, changedAt: 1000 };

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: workingActivity,
    },
    state: createTerminalState(),
  });

  const snapshots: Array<{ cwd: string; terminalIds: string[] }> = [];
  manager.subscribeTerminalsChanged((event) => {
    snapshots.push({ cwd: event.cwd, terminalIds: event.terminals.map((terminal) => terminal.id) });
  });
  const contributions: TerminalWorkspaceContributionChangedEvent[] = [];
  manager.subscribeTerminalWorkspaceContributionChanged((event) => {
    contributions.push(event);
  });

  manager.killTerminal("terminal-a");
  const request = worker.sentMessages.find(
    (message) => message.type === "killTerminal" && message.terminalId === "terminal-a",
  );
  if (!request) {
    throw new Error("killTerminal request not sent");
  }
  worker.emitWorkerMessage({ type: "response", requestId: request.requestId, ok: true });

  worker.emitWorkerMessage({
    type: "terminalExit",
    terminalId: "terminal-a",
    info: {
      exitCode: null,
      signal: null,
      lastOutputLines: [],
    },
  });

  expect(manager.getTerminal("terminal-a")).toBeUndefined();
  expect(snapshots).toEqual([{ cwd: "/workspace", terminalIds: [] }]);
  expect(contributions).toEqual([
    {
      terminalId: "terminal-a",
      cwd: "/workspace",
      workspaceId: "ws-test",
    },
  ]);
});
