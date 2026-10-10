import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { syncFilePublication } from "../atomic-file.js";
import {
  captureProcessTree,
  readLinuxProcessEntry,
  terminateWithTreeKill,
  type ProcessTreeEntry,
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
  test.skipIf(process.platform === "win32").each([false, true])(
    "handoff stop acknowledgement retries without signalling again after failed sync (restart: %s)",
    async (restart) => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-stop-sync-"));
      const runtime = { agentId: "agent", generationId: "b5992186-a159-4d19-85e7-2b6331180ee7" };
      const root = { pid: 4101, parentPid: 1, startedAt: "owner", exited: false };
      let entries = [root];
      let failReceipt = true;
      const signals: number[] = [];
      const options = {
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        syncPublication: async (file: string, parent: string) => {
          const saved = JSON.parse(await readFile(file, "utf8"));
          if (failReceipt && saved.tree.state === "stopped") throw new Error("receipt sync failed");
          await syncFilePublication(file, parent);
        },
        processTree: {
          bootId: async () => "boot",
          list: async () => entries,
          signal: (pid: number) => {
            signals.push(pid);
            entries = [];
          },
        },
      };
      const registry = createManagedProcessRegistry(options);
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        runtime,
        pid: root.pid,
        command: "claude",
        args: [],
        processTree: { bootId: "boot", entries: [root] },
      });
      await registry.retireStoppedRuntime(runtime);
      expect(await registry.list()).toEqual([record]);
      await expect(registry.stop(record.id)).rejects.toThrow("receipt sync failed");
      const recovered = restart ? createManagedProcessRegistry(options) : registry;
      await expect(recovered.stop(record.id)).rejects.toThrow("receipt sync failed");
      failReceipt = false;
      await recovered.stop(record.id);
      expect(signals).toEqual([root.pid]);
      await recovered.retireStoppedRuntime(runtime);
      expect(await recovered.list({ includeStopped: true })).toEqual([]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "handoff stopped runtime keeps its acknowledgement across restart until its owner retires it",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-stop-receipt-"));
      const runtime = { agentId: "agent", generationId: "b5992186-a159-4d19-85e7-2b6331180ee7" };
      const root = { pid: 4101, parentPid: 1, startedAt: "owner", exited: false };
      let entries = [root];
      const signals: number[] = [];
      const options = {
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        processTree: {
          bootId: async () => "boot",
          list: async () => entries,
          signal: (pid: number) => {
            signals.push(pid);
            entries = [];
          },
        },
      };
      const registry = createManagedProcessRegistry(options);
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        runtime,
        pid: root.pid,
        command: "claude",
        args: [],
        processTree: { bootId: "boot", entries: [root] },
      });
      await registry.stop(record.id);
      const recovered = createManagedProcessRegistry(options);
      // The PID now belongs to unrelated work. A retry consumes the saved result.
      entries = [{ ...root, startedAt: "replacement" }];
      await recovered.remove(record.id);
      await expect(recovered.stop(record.id)).resolves.toBeUndefined();
      expect(signals).toEqual([root.pid]);
      expect(await recovered.list()).toEqual([]);
      expect(await recovered.list({ includeStopped: true })).toEqual([
        { ...record, tree: { ...record.tree, state: "stopped" } },
      ]);
      expect(await recovered.reapStale()).toMatchObject({ checked: 0, errors: [] });
      await expect(recovered.admitLaunch(record.id)).rejects.toThrow("launch cannot be admitted");
      await recovered.retireStoppedRuntime({ ...runtime, generationId: "another-generation" });
      await expect(recovered.stop(record.id)).resolves.toBeUndefined();
      await recovered.retireStoppedRuntime(runtime);
      expect(await recovered.list({ includeStopped: true })).toEqual([]);
      await expect(recovered.stop(record.id)).rejects.toThrow("Managed process record is missing");
    },
  );

  test.runIf(process.platform !== "win32")(
    "handoff cold recovery removes a gated launch that exited before admission",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-gated-exit-"));
      const child = spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        {
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const exited = once(child, "exit");
      const options = {
        paseoHome: tempHome,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      };
      try {
        await once(child.stdout!, "data");
        const registry = createManagedProcessRegistry(options);
        const record = await registry.record({
          owner: { provider: "claude", kind: "query" },
          pid: child.pid!,
          command: "claude",
          args: [],
          processTree: await captureProcessTree(child),
          launchGated: true,
        });
        child.kill("SIGKILL");
        await exited;
        const recovered = createManagedProcessRegistry(options);
        expect(await recovered.reapStale()).toMatchObject({ checked: 1, removed: 1, errors: [] });
        expect(await recovered.list()).toEqual([]);
        await expect(recovered.admitLaunch(record.id)).rejects.toThrow(
          "Managed process record is missing",
        );
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "handoff admission removes the exited-bootstrap exemption across restart",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-admitted-exit-"));
      const signals: number[] = [];
      const options = {
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        processTree: {
          bootId: async () => "boot",
          list: async () => [],
          signal: (pid: number) => {
            signals.push(pid);
          },
        },
      };
      const registry = createManagedProcessRegistry(options);
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        pid: 4101,
        command: "claude",
        args: [],
        processTree: {
          bootId: "boot",
          entries: [{ pid: 4101, parentPid: 1, startedAt: "root", exited: false }],
        },
        launchGated: true,
      });
      await registry.admitLaunch(record.id);
      const recovered = createManagedProcessRegistry(options);
      await expect(recovered.stop(record.id)).rejects.toThrow("termination timed out");
      await expect(recovered.admitLaunch(record.id)).rejects.toThrow("launch cannot be admitted");
      expect(await recovered.list()).toEqual([
        { ...record, tree: { ...record.tree, state: "running", inspectionPending: true } },
      ]);
      expect(signals).toEqual([]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "handoff gated inspection faults remain recoverable after restart without permitting admission",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-gated-inspection-"));
      let failInspection = true;
      const options = {
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        processTree: {
          bootId: async () => "boot",
          list: async () => {
            if (failInspection) throw new Error("Inspection unavailable");
            return [];
          },
          signal: () => {
            throw new Error("No live bootstrap to signal");
          },
        },
      };
      const registry = createManagedProcessRegistry(options);
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        pid: 4101,
        command: "claude",
        args: [],
        processTree: {
          bootId: "boot",
          entries: [{ pid: 4101, parentPid: 1, startedAt: "root", exited: false }],
        },
        launchGated: true,
      });
      await expect(registry.stop(record.id)).rejects.toThrow("termination timed out");
      const recovered = createManagedProcessRegistry(options);
      await expect(recovered.admitLaunch(record.id)).rejects.toThrow("launch cannot be admitted");
      failInspection = false;
      await recovered.stop(record.id);
      expect(await recovered.list()).toEqual([]);
    },
  );

  test.runIf(process.platform === "linux")(
    "a fresh registry stops a real detached descendant after the recorded owner dies",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-orphan-"));
      const owner = spawn(
        process.execPath,
        [
          "-e",
          `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      process.stdout.write(String(child.pid) + String.fromCharCode(10));
      setInterval(() => {}, 1000);
    `,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let descendantPid: number | null = null;
      const exited = once(owner, "exit");
      try {
        const [output] = await Promise.race([
          once(owner.stdout!, "data"),
          exited.then(() => {
            throw new Error("Owner exited before reporting its child");
          }),
        ]);
        descendantPid = Number(String(output).trim());
        const options = {
          paseoHome: tempHome,
          processTable: createSystemManagedProcessTable(),
          terminateProcess: terminateWithTreeKill,
          logger: createTestLogger(),
        };
        const registry = createManagedProcessRegistry({
          ...options,
          terminateProcess: (child, stopOptions) =>
            terminateWithTreeKill(child, {
              ...stopOptions,
              onTreeObserved: async (tree) => {
                await stopOptions.onTreeObserved!(tree);
                throw new Error("Shutdown interrupted after its durable inventory");
              },
            }),
        });
        const checkpoint = await captureProcessTree(owner);
        expect(checkpoint.entries.map((entry) => entry.pid)).toContain(descendantPid);
        const record = await registry.record({
          owner: { provider: "claude", kind: "query" },
          pid: owner.pid!,
          command: process.execPath,
          args: [],
          processTree: checkpoint,
        });
        await expect(registry.stop(record.id)).rejects.toThrow("termination timed out");
        owner.kill("SIGKILL");
        await exited;
        expect(() => process.kill(descendantPid!, 0)).not.toThrow();
        const restarted = createManagedProcessRegistry(options);
        expect(await restarted.reapStale()).toMatchObject({
          checked: 1,
          removed: 1,
          terminated: 1,
          errors: [],
        });
        expect(await restarted.list()).toEqual([]);
        const stat = await readLinuxProcessEntry(descendantPid!);
        expect(stat === null || stat.exited).toBe(true);
      } finally {
        owner.kill("SIGKILL");
        await exited;
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The fixture may already have been reaped.
          }
        }
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "a launch checkpoint cannot certify an unexpected root exit",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-unexpected-exit-"));
      const signals: number[] = [];
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        processTree: {
          bootId: async () => "boot",
          list: async () => [],
          signal: (pid) => {
            signals.push(pid);
          },
        },
      });
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        pid: 4101,
        command: "claude",
        args: [],
        processTree: {
          bootId: "boot",
          entries: [{ pid: 4101, parentPid: 1, startedAt: "owner", exited: false }],
        },
      });
      await expect(registry.remove(record.id)).rejects.toThrow("Incomplete process inspection");
      await expect(registry.stop(record.id)).rejects.toThrow("termination timed out");
      await expect(registry.stop(record.id)).rejects.toThrow("Incomplete process inspection");
      expect(signals).toEqual([]);
      expect(await registry.list()).toEqual([
        { ...record, tree: { ...record.tree, inspectionPending: true } },
      ]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "cold recovery stops a recorded child after its owner disappeared",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-tree-"));
      const root = { pid: 4101, parentPid: 1, startedAt: "owner", exited: false };
      const child = { pid: 4102, parentPid: 1, startedAt: "child", exited: false };
      let entries: ProcessTreeEntry[] = [root, child];
      let interrupted = true;
      const signals: number[] = [];
      const options = {
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        processTree: {
          bootId: async () => "boot",
          list: async () => entries,
          signal: (pid: number) => {
            if (interrupted) {
              entries = [child];
              throw new Error("Shutdown interrupted after inventory");
            }
            signals.push(pid);
            entries = [];
          },
        },
      };
      const registry = createManagedProcessRegistry(options);
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        pid: root.pid,
        command: "claude",
        args: [],
        processTree: { bootId: "boot", entries: [root, child] },
      });
      await expect(registry.stop(record.id)).rejects.toThrow("termination timed out");
      await expect(registry.remove(record.id)).rejects.toThrow("still running");
      interrupted = false;
      const restarted = createManagedProcessRegistry(options);
      expect(await restarted.reapStale()).toEqual({
        checked: 1,
        dead: 0,
        mismatched: 0,
        removed: 1,
        terminated: 1,
        errors: [],
      });
      expect(signals).toEqual([4102]);
      expect(await restarted.list()).toEqual([]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "failed tree publication sends no signals and cold recovery retains its inspection obligation",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-tree-publication-"));
      const root = { pid: 4101, parentPid: 1, startedAt: "owner", exited: false };
      const child = { pid: 4102, parentPid: 4101, startedAt: "child", exited: false };
      let boot = "boot";
      let publications = 0;
      let inspections = 0;
      const signals: number[] = [];
      const options = {
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        processTree: {
          bootId: async () => boot,
          list: async () => {
            inspections++;
            return [root, child];
          },
          signal: (pid: number) => {
            signals.push(pid);
          },
        },
      };
      const registry = createManagedProcessRegistry({
        ...options,
        syncPublication: async (filePath) => {
          publications++;
          if (publications === 3) {
            // Model a failed complete publication whose rename never became durable.
            const record = JSON.parse(await readFile(filePath, "utf8"));
            record.tree = {
              checkpoint: { bootId: "boot", entries: [root] },
              inspectionPending: true,
              state: "running",
            };
            await writeFile(filePath, JSON.stringify(record));
            throw new Error("Publication failed");
          }
        },
      });
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        pid: root.pid,
        command: "claude",
        args: [],
        processTree: { bootId: "boot", entries: [root] },
      });
      await expect(registry.stop(record.id)).rejects.toThrow("termination timed out");
      expect(signals).toEqual([]);
      expect(inspections).toBe(1);
      const restarted = createManagedProcessRegistry(options);
      await expect(restarted.stop(record.id)).rejects.toThrow("Incomplete process inspection");
      expect(signals).toEqual([]);
      expect(inspections).toBe(1);
      expect((await restarted.list()).map((entry) => entry.id)).toEqual([record.id]);
      // A new boot proves the previous processes are gone without touching current PIDs.
      boot = "new-boot";
      await restarted.stop(record.id);
      expect(signals).toEqual([]);
      expect(inspections).toBe(1);
      expect(await restarted.list()).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32").each([
    {
      name: "before inspection",
      failureAt: 2,
      inspectedBeforeFault: 0,
      retainRoot: true,
      expectedSignals: [4102, 4101],
    },
    {
      name: "after inspection",
      failureAt: 3,
      inspectedBeforeFault: 1,
      retainRoot: false,
      expectedSignals: [4102],
    },
  ])(
    "repairs a known publication failure $name without clearing a cold unknown observation",
    async ({ failureAt, inspectedBeforeFault, retainRoot, expectedSignals }) => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-publication-retry-"));
      const root = { pid: 4101, parentPid: 1, startedAt: "owner", exited: false };
      const child = { pid: 4102, parentPid: 4101, startedAt: "child", exited: false };
      let entries = [root, child];
      const checkpoint = { bootId: "boot", entries: [root] };
      let publications = 0;
      let inspections = 0;
      const signals: number[] = [];
      const options = {
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        processTree: {
          bootId: async () => "boot",
          list: async () => {
            inspections++;
            return entries;
          },
          signal: (pid: number) => {
            signals.push(pid);
            entries = entries.filter((entry) => entry.pid !== pid);
          },
        },
      };
      const registry = createManagedProcessRegistry({
        ...options,
        syncPublication: async (filePath) => {
          if (++publications === failureAt) {
            const pending = JSON.parse(await readFile(filePath, "utf8"));
            pending.tree = { checkpoint, inspectionPending: true, state: "running" };
            await writeFile(filePath, JSON.stringify(pending));
            throw new Error("Interrupted publication");
          }
        },
      });
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        pid: root.pid,
        command: "claude",
        args: [],
        processTree: checkpoint,
      });
      await expect(registry.stop(record.id)).rejects.toThrow("termination timed out");
      expect(inspections).toBe(inspectedBeforeFault);
      expect(signals).toEqual([]);
      entries = retainRoot ? [root, child] : [{ ...child, parentPid: 1 }];
      const restarted = createManagedProcessRegistry(options);
      await expect(restarted.stop(record.id)).rejects.toThrow("Incomplete process inspection");
      expect(inspections).toBe(inspectedBeforeFault);
      expect(signals).toEqual([]);
      await registry.stop(record.id);
      expect(signals).toEqual(expectedSignals);
      expect(await registry.list()).toEqual([]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "a missing record cannot acknowledge process termination",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-missing-stop-"));
      const root = { pid: 4101, parentPid: 1, startedAt: "owner", exited: false };
      const signals: number[] = [];
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable: new FakeProcessTable([]),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
        processTree: {
          bootId: async () => "boot",
          list: async () => [root],
          signal: (pid) => {
            signals.push(pid);
          },
        },
      });
      const record = await registry.record({
        owner: { provider: "claude", kind: "query" },
        pid: root.pid,
        command: "claude",
        args: [],
        processTree: { bootId: "boot", entries: [root] },
      });
      await rm(path.join(tempHome, "runtime", "managed-processes", `${record.id}.json`));
      await expect(registry.stop(record.id)).rejects.toThrow("Managed process record is missing");
      expect(signals).toEqual([]);
    },
  );

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
