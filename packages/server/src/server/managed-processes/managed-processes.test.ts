import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createManagedProcessRegistry,
  createPidTarget,
  createSystemManagedProcessTable,
  type ManagedProcessCommandRunner,
  type ManagedProcessInspection,
  type ManagedProcessSnapshot,
  type ManagedProcessTable,
} from "./managed-processes.js";
import { spawnProcess } from "../../utils/spawn.js";
import {
  terminateWithTreeKill,
  type ProcessTerminator,
  type TreeKillTarget,
} from "../../utils/tree-kill.js";

let tempHome: string | null = null;

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("managed process registry", () => {
  test("handoff recovery recognizes the captured identity when executable paths are quoted", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-quoted-"));
    const command = path.join(tempHome, "Program Files", "node.exe");
    const script = path.join(tempHome, "helper script.cjs");
    const processTable = new FakeProcessTable([
      { pid: 4101, commandLine: `"${command}" "${script}"`, startedAt: "original-start" },
    ]);
    const terminator = new FakeProcessTerminator(processTable);
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "test", kind: "helper" },
      pid: 4101,
      command,
      args: [script],
    });
    expect(await registry.reapStale()).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([4101]);
    expect(await registry.list()).toEqual([]);
  });

  test("handoff inventory refuses provider cleanup of a helper that is still alive", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-remove-"));
    const processTable = new FakeProcessTable([
      { pid: 4101, commandLine: "opencode serve", startedAt: "original-start" },
    ]);
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: async () => "kill-timeout",
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4101,
      command: "opencode",
      args: ["serve"],
    });
    await expect(registry.remove(record.id)).rejects.toThrow(
      "Managed helper is still running after termination: 4101",
    );
    expect(await registry.list()).toEqual([record]);
    processTable.exited(4101);
    await registry.remove(record.id);
    expect(await registry.list()).toEqual([]);
    await expect(registry.remove(record.id)).resolves.toBeUndefined();
  });

  test("handoff recovery reports a corrupt inventory while still reaping valid dead records", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-corrupt-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([]),
      terminateProcess: async () => {
        throw new Error("No live process should be signalled");
      },
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4101,
      command: "opencode",
      args: ["serve"],
    });
    const directory = path.join(tempHome, "runtime", "managed-processes");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "damaged.json"), "{incomplete");
    const result = await registry.reapStale();
    expect(result).toMatchObject({ checked: 1, dead: 1, removed: 1, terminated: 0 });
    expect(result.errors).toEqual([{ id: "damaged.json", message: expect.any(String) }]);
    await expect(registry.list()).rejects.toThrow(
      "Managed process inventory is incomplete: damaged.json",
    );
    await rm(path.join(directory, "damaged.json"));
    expect(await registry.list()).toEqual([]);
  });

  test("handoff recovery retains a helper record after a termination timeout", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-timeout-"));
    const processTable = new FakeProcessTable([
      { pid: 4101, commandLine: "opencode serve --port 4101", startedAt: "original-start" },
    ]);
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: async () => "kill-timeout",
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4101,
      command: "opencode",
      args: ["serve", "--port", "4101"],
    });
    expect(await registry.reapStale()).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [{ id: record.id, message: "Managed helper termination timed out: 4101" }],
    });
    const reloaded = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: async () => "kill-timeout",
      logger: createTestLogger(),
    });
    expect(await reloaded.list()).toEqual([record]);
  });

  test("reaps a validated leftover helper process and deletes its record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator(processTable);
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4101,
      command: "opencode",
      args: ["serve", "--port", "4101"],
      metadata: { port: 4101 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([4101]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test.each(["already-exited", "terminated", "killed"] as const)(
    "handoff recovery verifies the helper after a %s termination result",
    async (termination) => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-confirm-"));
      const processTable = new FakeProcessTable([
        { pid: 4101, commandLine: "opencode serve --port 4101", startedAt: "original-start" },
      ]);
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable,
        terminateProcess: async () => termination,
        logger: createTestLogger(),
      });
      const record = await registry.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4101,
        command: "opencode",
        args: ["serve", "--port", "4101"],
      });
      expect(await registry.reapStale()).toEqual({
        checked: 1,
        dead: 0,
        mismatched: 0,
        removed: 0,
        terminated: 0,
        errors: [
          { id: record.id, message: "Managed helper is still running after termination: 4101" },
        ],
      });
      expect(await registry.list()).toEqual([record]);
    },
  );

  test("deletes a dead helper process record without terminating a PID", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4102,
        commandLine: "opencode serve --port 4102",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4102,
      command: "opencode",
      args: ["serve", "--port", "4102"],
      metadata: { port: 4102 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 1,
      mismatched: 0,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test.each([
    {
      reason: "changed command line",
      inspection: {
        status: "alive",
        snapshot: { pid: 4101, startedAt: "original-start", commandLine: "another program" },
      },
      message: "Managed helper is still running after termination: 4101",
    },
    {
      reason: "missing start identity",
      inspection: {
        status: "alive",
        snapshot: { pid: 4101, startedAt: null, commandLine: "opencode serve" },
      },
      message: "Managed helper is still running after termination: 4101",
    },
    {
      reason: "inspection failure",
      inspection: { status: "error", error: new Error("inspection failed after termination") },
      message: "inspection failed after termination",
    },
  ] satisfies Array<{ reason: string; inspection: ManagedProcessInspection; message: string }>)(
    "handoff recovery retains the record after termination with $reason",
    async ({ inspection, message }) => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-uncertain-"));
      let current: ManagedProcessInspection = {
        status: "alive",
        snapshot: { pid: 4101, startedAt: "original-start", commandLine: "opencode serve" },
      };
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable: { inspect: async () => current },
        terminateProcess: async () => {
          current = inspection;
          return "terminated";
        },
        logger: createTestLogger(),
      });
      const record = await registry.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4101,
        command: "opencode",
        args: ["serve"],
      });
      expect(await registry.reapStale()).toEqual({
        checked: 1,
        dead: 0,
        mismatched: 0,
        removed: 0,
        terminated: 0,
        errors: [{ id: record.id, message }],
      });
      expect(await registry.list()).toEqual([record]);
    },
  );

  test("removes a reused PID record without terminating the new process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4103,
          commandLine: "opencode serve --port 4103",
          startedAt: "original-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4103,
      command: "opencode",
      args: ["serve", "--port", "4103"],
      metadata: { port: 4103 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4103,
          commandLine: "opencode serve --port 4103",
          startedAt: "new-process-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("keeps a helper record when inspection fails instead of orphaning a live process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        { pid: 4104, commandLine: "opencode serve --port 4104", startedAt: "process-start-token" },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4104,
      command: "opencode",
      args: ["serve", "--port", "4104"],
      metadata: { port: 4104 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4104]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
    });
    expect(result.errors).toEqual([{ id: expect.any(String), message: "inspection failed" }]);
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toHaveLength(1);
  });

  test("does not terminate a reused PID whose command line only mentions the tokens", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4105]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4105,
      command: "opencode",
      args: ["serve", "--port", "4105"],
      metadata: { port: 4105 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4105,
          commandLine: "node /tmp/serve.js --port 4105 # opencode helper",
          startedAt: null,
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });
});

describe("managed process termination", () => {
  test("handoff recovery retains a real live helper across restart and removes it only after confirmed exit", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-real-"));
    const script = path.join(tempHome, "helper.cjs");
    await writeFile(script, "setInterval(() => {}, 1000);");
    const child = spawnProcess(process.execPath, [script], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await once(child, "spawn");
    const pid = child.pid;
    if (!pid) throw new Error("Missing helper PID");
    const processTable = createSystemManagedProcessTable();
    try {
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable,
        terminateProcess: async () => "kill-timeout",
        logger: createTestLogger(),
      });
      const record = await registry.record({
        owner: { provider: "test", kind: "helper" },
        pid,
        command: process.execPath,
        args: [script],
      });
      expect(await registry.reapStale()).toMatchObject({
        removed: 0,
        terminated: 0,
        errors: [{ id: record.id, message: `Managed helper termination timed out: ${pid}` }],
      });
      expect(await processTable.inspect(pid)).toMatchObject({ status: "alive" });
      await expect(registry.remove(record.id)).rejects.toThrow(
        `Managed helper is still running after termination: ${pid}`,
      );
      const restarted = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable,
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      });
      expect(await restarted.list()).toEqual([record]);
      expect(await restarted.reapStale()).toEqual({
        checked: 1,
        dead: 0,
        mismatched: 0,
        removed: 1,
        terminated: 1,
        errors: [],
      });
      await exited;
      expect(await processTable.inspect(pid)).toEqual({ status: "not-found" });
      expect(await restarted.list()).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  }, 30_000);

  test("stops as soon as a terminated process exits instead of escalating to SIGKILL", async () => {
    const child = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to spawn test process");
    }

    let forced = false;
    const result = await terminateWithTreeKill(createPidTarget(pid), {
      gracefulTimeoutMs: 2_000,
      forceTimeoutMs: 1_000,
      onForceSignal: () => {
        forced = true;
      },
    });

    expect(result).toBe("terminated");
    expect(forced).toBe(false);
  });
});

describe("system managed process table", () => {
  test.each(["", "partial output", "Sat Jun 20 10:30:40 2026"])(
    "handoff recovery treats incomplete successful ps output as unknown: %s",
    async (stdout) => {
      const table = createSystemManagedProcessTable({
        platform: "darwin",
        commandRunner: new FakeCommandRunner([{ stdout, stderr: "" }]),
      });
      expect(await table.inspect(4101)).toMatchObject({
        status: "error",
        error: { message: "Incomplete process inspection for PID 4101" },
      });
    },
  );

  test.each([
    { code: 1, stdout: "", stderr: "ps: permission denied" },
    { code: 2, stdout: "", stderr: "ps: invalid option" },
    { code: 1, stdout: "unexpected partial output", stderr: "" },
    { code: "ENOENT", stdout: "", stderr: "" },
  ])("handoff recovery preserves uncertainty when ps fails: $code / $stderr", async (failure) => {
    const error = Object.assign(new Error("process inspection failed"), failure);
    const table = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner: {
        exec: async () => {
          throw error;
        },
      },
    });
    expect(await table.inspect(4101)).toEqual({ status: "error", error });
  });

  test("handoff recovery recognizes a normal ps no-match exit", async () => {
    const table = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner: {
        exec: async () => {
          throw Object.assign(new Error("no processes"), { code: 1, stdout: "", stderr: "" });
        },
      },
    });
    expect(await table.inspect(4101)).toEqual({ status: "not-found" });
  });

  test("reads POSIX process identity from ps", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: "Sat Jun 20 10:30:40 2026 opencode serve --port 4101\n",
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner,
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "Sat Jun 20 10:30:40 2026",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "ps",
        args: ["-ww", "-p", "4101", "-o", "lstart=", "-o", "command="],
      },
    ]);
  });

  test("reads Windows process identity from PowerShell", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: JSON.stringify({
          ProcessId: 4101,
          CommandLine: "C:\\opencode.exe serve --port 4101",
          CreationDate: "20260620103040.000000+000",
        }),
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "win32",
      commandRunner,
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "C:\\opencode.exe serve --port 4101",
        startedAt: "20260620103040.000000+000",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$process = Get-CimInstance Win32_Process -Filter 'ProcessId = 4101'; if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
        ],
      },
    ]);
  });
});

class FakeProcessTable implements ManagedProcessTable {
  private readonly snapshots: Map<number, ManagedProcessSnapshot>;
  private readonly errorPids: Set<number>;

  constructor(snapshots: ManagedProcessSnapshot[], errorPids: number[] = []) {
    this.snapshots = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
    this.errorPids = new Set(errorPids);
  }

  exited(pid: number): void {
    this.snapshots.delete(pid);
  }

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    if (this.errorPids.has(pid)) {
      return { status: "error", error: new Error("inspection failed") };
    }
    const snapshot = this.snapshots.get(pid);
    return snapshot ? { status: "alive", snapshot } : { status: "not-found" };
  }
}

class FakeProcessTerminator {
  readonly terminatedPids: number[] = [];

  constructor(private readonly processTable?: FakeProcessTable) {}

  readonly terminate: ProcessTerminator = async (target: TreeKillTarget) => {
    this.terminatedPids.push(target.pid ?? -1);
    this.processTable?.exited(target.pid ?? -1);
    return "terminated";
  };
}

class FakeCommandRunner implements ManagedProcessCommandRunner {
  readonly commands: Array<{ command: string; args: string[] }> = [];
  private readonly responses: Array<{ stdout: string; stderr: string }>;

  constructor(responses: Array<{ stdout: string; stderr: string }>) {
    this.responses = [...responses];
  }

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ command, args });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake process-table command response available");
    }
    return response;
  }
}
