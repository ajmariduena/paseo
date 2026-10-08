import type { CpuInfo } from "node:os";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { HostMetricsSampler } from "./sampler.js";
import type { HostMetricsSystem } from "./system.js";

const GIB = 1024 ** 3;
const KIB = 1024;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages active:                                 100000.
Pages wired down:                              50000.
Pages occupied by compressor:                  50000.
`;

const DF = `Filesystem   1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1  1000000    100000    400000    20%    /
/dev/disk3s5    1000000    500000    400000    56%    /System/Volumes/Data
`;

const PS = [
  "  100     1  40.0  2048 /Applications/Paseo.app/Contents/MacOS/Paseo",
  "  200   100   5.0  1024 /usr/local/bin/node",
  "  300     1   0.5  4096 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "",
].join("\n");

const PS_ENV = [
  "  100 /Applications/Paseo.app/Contents/MacOS/Paseo HOME=/Users/me",
  "  200 /usr/local/bin/node server.js PASEO_AGENT_ID=agent-7 HOME=/Users/me",
  "  300 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome HOME=/Users/me",
  "",
].join("\n");

type CommandResponder = () => Promise<string>;

const LINUX_FILES = new Map([
  ["/proc/meminfo", "MemTotal:       16777216 kB\nMemAvailable:    2097152 kB\n"],
  ["/etc/os-release", 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\n'],
  ["/proc/100/environ", "HOME=/root\0"],
  ["/proc/200/environ", "HOME=/root\0PASEO_AGENT_ID=agent-7\0"],
]);

interface HarnessOptions {
  platform?: "darwin" | "linux";
  historyLength?: number;
  failCommands?: boolean;
}

function createHarness(options?: HarnessOptions) {
  let now = 1_000_000;
  let busyFraction = 0.5;
  let busyMs = 0;
  let idleMs = 0;
  let tick: (() => void) | null = null;
  const calls: string[] = [];
  const responders = new Map<string, CommandResponder>([
    ["vm_stat", async () => VM_STAT],
    ["sysctl -n kern.memorystatus_vm_pressure_level", async () => "2\n"],
    ["df -kP", async () => DF],
    ["ps -ww -axo pid=,ppid=,pcpu=,rss=,comm=", async () => PS],
    ["sw_vers -productVersion", async () => "26.5.2\n"],
  ]);

  function advance(ms: number): void {
    now += ms;
    busyMs += ms * busyFraction;
    idleMs += ms * (1 - busyFraction);
  }

  function cpus(): CpuInfo[] {
    const times = { user: busyMs, nice: 0, sys: 0, idle: idleMs, irq: 0 };
    return [
      { model: "Apple M5", speed: 0, times },
      { model: "Apple M5", speed: 0, times },
    ];
  }

  const system: HostMetricsSystem = {
    platform: options?.platform ?? "darwin",
    os: {
      cpus,
      totalmem: () => 16 * GIB,
      freemem: () => 4 * GIB,
      hostname: () => "studio.local",
      arch: () => "arm64",
      uptime: () => 3600,
      type: () => "Darwin",
      release: () => "25.5.0",
    },
    async run(command, args) {
      const key = [command, ...args].join(" ");
      calls.push(key);
      if (options?.failCommands) throw new Error(`${command} failed`);
      if (command === "ps" && args[0] === "-E") return PS_ENV;
      const responder = responders.get(key);
      if (!responder) throw new Error(`unexpected command: ${key}`);
      return responder();
    },
    async readFile(filePath) {
      calls.push(`read ${filePath}`);
      const contents = LINUX_FILES.get(filePath);
      if (contents === undefined) throw new Error(`ENOENT: ${filePath}`);
      return contents;
    },
    readDir: async () => ["Macintosh HD", "Backup"],
    readLink: async (linkPath) => {
      if (linkPath === "/Volumes/Macintosh HD") return "/";
      throw new Error("not a link");
    },
    statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 250 }),
  };

  const sampler = new HostMetricsSampler({
    logger: pino({ level: "silent" }),
    system,
    timers: {
      now: () => now,
      every(callback) {
        tick = callback;
        return () => {
          tick = null;
        };
      },
      sleep: async (ms) => advance(ms),
    },
    historyLength: options?.historyLength,
  });

  return {
    sampler,
    calls,
    responders,
    setBusy(fraction: number) {
      busyFraction = fraction;
    },
    async elapse(ms: number) {
      advance(ms);
      tick?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    countCalls(prefix: string) {
      return calls.filter((call) => call.startsWith(prefix)).length;
    },
  };
}

describe("HostMetricsSampler", () => {
  it("answers the first request with a full snapshot over the initial CPU window", async () => {
    const harness = createHarness();

    const [snapshot, concurrent] = await Promise.all([
      harness.sampler.getSnapshot(),
      harness.sampler.getSnapshot(),
    ]);

    expect(concurrent).toEqual(snapshot);
    expect(harness.countCalls("vm_stat")).toBe(1);
    expect(harness.sampler.isRunning()).toBe(true);
    expect(snapshot).toEqual({
      sampledAt: new Date(1_000_200).toISOString(),
      sampleIntervalMs: 2000,
      hostname: "studio.local",
      platform: "darwin",
      osLabel: "macOS 26.5.2",
      arch: "arm64",
      uptimeSeconds: 3600,
      cpu: { model: "Apple M5", cores: 2, percent: 50 },
      memory: { totalBytes: 16 * GIB, usedBytes: 200000 * 16384, pressure: "warn" },
      disks: [
        {
          mount: "/",
          name: "Macintosh HD",
          totalBytes: 1000000 * KIB,
          usedBytes: 600000 * KIB,
        },
      ],
      history: { cpuPercent: [50], memoryPercent: [19.1] },
      processes: [
        { pid: 100, name: "Paseo", cpuPercent: 40, memoryBytes: 2048 * KIB, agentId: null },
        { pid: 200, name: "node", cpuPercent: 5, memoryBytes: 1024 * KIB, agentId: "agent-7" },
        {
          pid: 300,
          name: "Google Chrome",
          cpuPercent: 0.5,
          memoryBytes: 4096 * KIB,
          agentId: null,
        },
      ],
    });
  });

  it("appends one history entry per tick, oldest first, capped at the history length", async () => {
    const harness = createHarness({ historyLength: 3 });
    await harness.sampler.getSnapshot();

    for (const fraction of [0.1, 0.2, 0.3]) {
      harness.setBusy(fraction);
      await harness.elapse(2000);
    }

    const snapshot = await harness.sampler.getSnapshot();
    expect(snapshot.history).toEqual({
      cpuPercent: [10, 20, 30],
      memoryPercent: [19.1, 19.1, 19.1],
    });
    expect(snapshot.cpu.percent).toBe(30);
  });

  it("stops after the idle timeout and starts over on the next request", async () => {
    const harness = createHarness();
    await harness.sampler.getSnapshot();

    for (let elapsed = 0; elapsed < 30_000; elapsed += 2000) await harness.elapse(2000);

    expect(harness.sampler.isRunning()).toBe(false);
    const callsWhenStopped = harness.calls.length;
    await harness.elapse(2000);
    expect(harness.calls.length).toBe(callsWhenStopped);

    const restarted = await harness.sampler.getSnapshot();
    expect(harness.sampler.isRunning()).toBe(true);
    expect(restarted.history.cpuPercent).toEqual([50]);
  });

  it("skips a tick while the previous sample is still running", async () => {
    const harness = createHarness();
    await harness.sampler.getSnapshot();
    let release: (output: string) => void = () => {};
    harness.responders.set(
      "vm_stat",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    await harness.elapse(2000);
    await harness.elapse(2000);
    expect(harness.countCalls("vm_stat")).toBe(2);

    release(VM_STAT);
    await harness.elapse(0);
    await harness.elapse(2000);
    expect(harness.countCalls("vm_stat")).toBe(3);
  });

  it("samples disks every 30 seconds instead of every tick", async () => {
    const harness = createHarness();
    await harness.sampler.getSnapshot();

    for (let elapsed = 0; elapsed < 30_000; elapsed += 2000) {
      await harness.elapse(2000);
      await harness.sampler.getSnapshot();
    }

    expect(harness.countCalls("df")).toBe(2);
  });

  it("looks up agent ids only for processes it has not seen", async () => {
    const harness = createHarness();
    await harness.sampler.getSnapshot();
    await harness.elapse(2000);

    expect(harness.calls.filter((call) => call.startsWith("ps -E"))).toEqual([
      "ps -E -ww -o pid=,command= -p 100,200,300",
    ]);
  });

  it("reads memory, OS name and agent ids from /proc on Linux", async () => {
    const harness = createHarness({ platform: "linux" });

    const snapshot = await harness.sampler.getSnapshot();

    expect(snapshot).toMatchObject({
      osLabel: "Ubuntu 24.04.1 LTS",
      memory: { totalBytes: 16 * GIB, usedBytes: 14 * GIB, pressure: "warn" },
    });
    expect(snapshot.processes.map((process) => [process.pid, process.agentId])).toEqual([
      [100, null],
      [200, "agent-7"],
      [300, null],
    ]);
  });

  it("degrades to os and statfs readings when every command fails", async () => {
    const harness = createHarness({ failCommands: true });

    const snapshot = await harness.sampler.getSnapshot();

    expect(snapshot).toMatchObject({
      osLabel: "Darwin 25.5.0",
      memory: { totalBytes: 16 * GIB, usedBytes: 12 * GIB, pressure: null },
      disks: [{ mount: "/", name: "/", totalBytes: 4096 * 1000, usedBytes: 4096 * 750 }],
      processes: [],
    });
  });

  it("stops sampling when disposed", async () => {
    const harness = createHarness();
    await harness.sampler.getSnapshot();

    harness.sampler.dispose();

    expect(harness.sampler.isRunning()).toBe(false);
  });
});
