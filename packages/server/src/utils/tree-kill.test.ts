import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  readLinuxProcessEntry,
  terminateWithTreeKill,
  type ProcessTreeEntry,
  type TreeKillTarget,
} from "./tree-kill.js";

const pollIntervalMs = 50;

let tempDir: string | null = null;
let ownerProcess: ChildProcess | null = null;
let descendantPid: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  async function poll(): Promise<void> {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(pollIntervalMs);
    return poll();
  }
  return poll();
}

async function readPidFileNumber(filePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(filePath, "utf-8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killIfRunning(pid: number | null | undefined): void {
  if (!pid || !isProcessRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore cleanup races.
  }
}

function spawnOwnerWithDescendant(options: {
  childPidPath: string;
  detachedDescendant: boolean;
  ownerIgnoresTerm?: boolean;
  descendantTitle?: string;
}): ChildProcess {
  const descendantOptions = options.detachedDescendant
    ? '{ detached: true, stdio: "ignore" }'
    : '{ stdio: "ignore" }';
  const childUnref = options.detachedDescendant ? "child.unref();" : "";

  return spawn(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        ${options.ownerIgnoresTerm === false ? "" : 'process.on("SIGTERM", () => {});'}
        const child = spawn(process.execPath, [
          "-e",
          ${JSON.stringify(`
            const fs = require("node:fs");
            ${options.descendantTitle ? `process.title = ${JSON.stringify(options.descendantTitle)};` : ""}
            process.on("SIGTERM", () => {});
            fs.writeFileSync(${JSON.stringify(options.childPidPath)}, String(process.pid));
            setInterval(() => {}, 1000);
          `)}
        ], ${descendantOptions});
        ${childUnref}
        setInterval(() => {}, 1000);
      `,
    ],
    { stdio: "ignore" },
  );
}

async function waitForFixtureReady(childPidPath: string): Promise<void> {
  await waitFor(
    async () => {
      descendantPid = await readPidFileNumber(childPidPath);
      return (
        isProcessRunning(ownerProcess?.pid ?? -1) &&
        descendantPid !== null &&
        isProcessRunning(descendantPid)
      );
    },
    5000,
    "owner descendant did not become running in time",
  );
}

async function expectOwnerAndDescendantStopped(message: string): Promise<void> {
  await waitFor(
    () => !isProcessRunning(ownerProcess?.pid ?? -1) && !isProcessRunning(descendantPid ?? -1),
    5000,
    message,
  );
}

afterEach(async () => {
  killIfRunning(ownerProcess?.pid);
  killIfRunning(descendantPid);
  ownerProcess = null;
  descendantPid = null;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("terminateWithTreeKill", () => {
  test.runIf(process.platform !== "win32")(
    "strict termination refuses an exited owner with an unobserved surviving child",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-tree-unobserved-"));
      const childPidPath = join(tempDir, "descendant.pid");
      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
        ownerIgnoresTerm: false,
      });
      await waitForFixtureReady(childPidPath);
      const exited = new Promise<void>((resolve) => ownerProcess!.once("exit", () => resolve()));
      ownerProcess.kill("SIGKILL");
      await exited;
      expect(isProcessRunning(descendantPid ?? -1)).toBe(true);
      const options = { gracefulTimeoutMs: 0, forceTimeoutMs: 0, requireTreeProof: true };
      expect(await terminateWithTreeKill(ownerProcess, options)).toBe("kill-timeout");
      expect(await terminateWithTreeKill(ownerProcess, options)).toBe("kill-timeout");
      expect(isProcessRunning(descendantPid ?? -1)).toBe(true);
    },
  );

  test("strict termination refuses an owner that exits during first inspection without signalling a replacement", async () => {
    const owner: TreeKillTarget = { pid: 101, exitCode: null, kill: () => true };
    const signals: number[] = [];
    expect(
      await terminateWithTreeKill(owner, {
        gracefulTimeoutMs: 0,
        forceTimeoutMs: 0,
        requireTreeProof: true,
        processTree: {
          list: async () => {
            owner.exitCode = 0;
            return [{ pid: 101, parentPid: 1, startedAt: "replacement", exited: false }];
          },
          signal: (pid) => {
            signals.push(pid);
          },
        },
      }),
    ).toBe("kill-timeout");
    expect(signals).toEqual([]);
  });

  test.each(["ENOENT", "ESRCH"])(
    "accepts process exit during a kernel identity read (%s)",
    async (code) => {
      const readStat = async () => {
        throw Object.assign(new Error("process exited"), { code });
      };
      await expect(readLinuxProcessEntry(101, readStat)).resolves.toBeNull();
    },
  );

  test("refuses unreadable and incomplete kernel process identities", async () => {
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    await expect(
      readLinuxProcessEntry(101, async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
    await expect(readLinuxProcessEntry(101, async () => "")).rejects.toThrow(
      "Incomplete kernel process identity",
    );
  });

  test("handoff termination shares one in-flight stop for concurrent callers", async () => {
    const owner: TreeKillTarget = { pid: 101, kill: () => true };
    const inspected = Promise.withResolvers<void>();
    let reads = 0;
    let alive = true;
    const signals: number[] = [];
    const options = {
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
      processTree: {
        list: async () => {
          reads += 1;
          await inspected.promise;
          return alive ? [{ pid: 101, parentPid: 1, startedAt: "parent", exited: false }] : [];
        },
        signal: (pid: number) => {
          signals.push(pid);
          alive = false;
        },
      },
    };
    const first = terminateWithTreeKill(owner, options);
    const second = terminateWithTreeKill(owner, options);
    try {
      expect(reads).toBe(1);
    } finally {
      inspected.resolve();
      await Promise.all([first, second]);
    }
    expect(await first).toBe("terminated");
    expect(await second).toBe("terminated");
    expect(signals).toEqual([101]);
  });

  test("handoff termination does not signal a reused descendant PID", async () => {
    const processes = new Map<number, ProcessTreeEntry>([
      [101, { pid: 101, parentPid: 1, startedAt: "parent", exited: false }],
      [102, { pid: 102, parentPid: 101, startedAt: "child", exited: false }],
    ]);
    const signals: Array<[number, NodeJS.Signals]> = [];
    const result = await terminateWithTreeKill(
      { pid: 101, kill: () => true },
      {
        gracefulTimeoutMs: 0,
        forceTimeoutMs: 0,
        processTree: {
          list: async () => [...processes.values()],
          signal: (pid, signal) => {
            signals.push([pid, signal]);
            if (pid === 101) {
              processes.delete(101);
              processes.set(102, {
                pid: 102,
                parentPid: 1,
                startedAt: "replacement",
                exited: false,
              });
            }
          },
        },
      },
    );
    expect(result).toBe("terminated");
    expect(signals).toEqual([
      [102, "SIGTERM"],
      [101, "SIGTERM"],
    ]);
    expect([...processes.values()]).toEqual([
      { pid: 102, parentPid: 1, startedAt: "replacement", exited: false },
    ]);
  });

  test("handoff termination discovers new descendants of a reparented child during shutdown", async () => {
    const processes = new Map<number, ProcessTreeEntry>([
      [101, { pid: 101, parentPid: 1, startedAt: "parent", exited: false }],
      [102, { pid: 102, parentPid: 101, startedAt: "child", exited: false }],
    ]);
    const signals: Array<[number, NodeJS.Signals]> = [];
    const result = await terminateWithTreeKill(
      { pid: 101, kill: () => true },
      {
        gracefulTimeoutMs: 0,
        forceTimeoutMs: 0,
        processTree: {
          list: async () => [...processes.values()],
          signal: (pid, signal) => {
            signals.push([pid, signal]);
            if (pid === 101) {
              processes.delete(101);
              processes.set(102, { pid: 102, parentPid: 1, startedAt: "child", exited: false });
              processes.set(103, {
                pid: 103,
                parentPid: 102,
                startedAt: "grandchild",
                exited: false,
              });
            }
            if (signal === "SIGKILL") processes.delete(pid);
          },
        },
      },
    );
    expect(result).toBe("killed");
    expect(signals).toEqual([
      [102, "SIGTERM"],
      [101, "SIGTERM"],
      [103, "SIGKILL"],
      [102, "SIGKILL"],
    ]);
    expect([...processes.keys()]).toEqual([]);
  });

  test("handoff termination cannot certify an unknown tree after a failed inspection and owner exit", async () => {
    const owner: TreeKillTarget = { pid: 101, exitCode: null, kill: () => true };
    let inspectionFails = true;
    const signals: number[] = [];
    const options = {
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
      processTree: {
        list: async () => {
          if (inspectionFails) throw new Error("process inventory unavailable");
          return [];
        },
        signal: (pid: number) => {
          signals.push(pid);
        },
      },
    };
    expect(await terminateWithTreeKill(owner, options)).toBe("kill-timeout");
    owner.exitCode = 0;
    inspectionFails = false;
    expect(await terminateWithTreeKill(owner, options)).toBe("kill-timeout");
    expect(signals).toEqual([]);
  });

  test("handoff termination reports failure when signalling the tree is denied", async () => {
    const signals: number[] = [];
    const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const errors: unknown[] = [];
    const result = await terminateWithTreeKill(
      { pid: 101, kill: () => true },
      {
        gracefulTimeoutMs: 0,
        forceTimeoutMs: 0,
        onError: (error) => {
          errors.push(error);
        },
        processTree: {
          list: async () => [{ pid: 101, parentPid: 1, startedAt: "parent", exited: false }],
          signal: (pid) => {
            signals.push(pid);
            throw denied;
          },
        },
      },
    );
    expect(result).toBe("kill-timeout");
    expect(signals).toEqual([101]);
    expect(errors).toEqual([denied]);
  });

  test("handoff termination retries a surviving descendant after its owner has exited", async () => {
    const processes = new Map<number, ProcessTreeEntry>([
      [101, { pid: 101, parentPid: 1, startedAt: "parent", exited: false }],
      [102, { pid: 102, parentPid: 101, startedAt: "child", exited: false }],
    ]);
    const owner: TreeKillTarget = { pid: 101, exitCode: null, kill: () => true };
    let canKillDescendant = false;
    const options = {
      requireTreeProof: true,
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
      processTree: {
        list: async () => [...processes.values()],
        signal: (pid: number, signal: NodeJS.Signals) => {
          if (pid === 101) {
            processes.delete(pid);
            owner.exitCode = 0;
          }
          if (pid === 102 && signal === "SIGKILL" && canKillDescendant) processes.delete(pid);
        },
      },
    };
    expect(await terminateWithTreeKill(owner, options)).toBe("kill-timeout");
    expect([...processes.keys()]).toEqual([102]);
    canKillDescendant = true;
    expect(await terminateWithTreeKill(owner, options)).toBe("killed");
    expect([...processes.keys()]).toEqual([]);
    expect(await terminateWithTreeKill(owner, options)).toBe("already-exited");
  });

  test.runIf(process.platform !== "win32")(
    "handoff termination waits for descendants even when their owner exits first",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-owner-exit-"));
      const childPidPath = join(tempDir, "descendant.pid");
      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
        ownerIgnoresTerm: false,
        descendantTitle: "paseo ) child",
      });
      await waitForFixtureReady(childPidPath);
      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
      });
      expect(result).toBe("killed");
      await expectOwnerAndDescendantStopped("descendant survived the exit of its owner");
    },
  );

  test.runIf(process.platform === "win32")(
    "kills Windows descendants through taskkill tree cleanup",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: false,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 2000,
        forceTimeoutMs: 2000,
      });

      // tree-kill uses taskkill /T /F on Windows, so the first signal is already forceful.
      expect(result).toBe("terminated");
      await expectOwnerAndDescendantStopped(
        "owner or Windows descendant survived terminateWithTreeKill",
      );
    },
  );

  test.runIf(process.platform !== "win32")(
    "force-kills descendants that started their own process group",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
      });

      expect(result).toBe("killed");
      await expectOwnerAndDescendantStopped(
        "owner or separate-process-group descendant survived terminateWithTreeKill",
      );
    },
  );
});
