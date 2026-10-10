import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceFleetDigest } from "@getpaseo/protocol/voice-fleet/types";
import {
  buildFleetHostStates,
  createFleetSyncLoop,
  createOperationDedupe,
  rememberFleetHosts,
  selectDigestHosts,
  type FleetHost,
} from "./fleet-courier-state";

function digest(generatedAt: string): VoiceFleetDigest {
  return { generatedAt, agents: [], workspaces: [], projects: [], sessions: [] };
}

const mini: FleetHost = {
  serverId: "mini",
  label: "Mac mini",
  isConnected: true,
  supportsFleet: true,
};
const vps: FleetHost = { serverId: "vps", label: "VPS", isConnected: true, supportsFleet: false };

describe("fleet host states", () => {
  it("asks only connected hosts that serve digests", () => {
    const offline = { ...mini, serverId: "old", isConnected: false };

    expect(selectDigestHosts([mini, vps, offline])).toEqual([mini]);
  });

  it("reports connected hosts with their fresh digest", () => {
    const remembered = rememberFleetHosts({
      previous: new Map(),
      hosts: [mini, vps],
      digests: new Map([["mini", digest("t1")]]),
      now: "2026-10-09T10:00:00.000Z",
    });

    expect(buildFleetHostStates({ hosts: [mini, vps], remembered })).toEqual([
      {
        serverId: "mini",
        label: "Mac mini",
        online: true,
        lastSeenAt: "2026-10-09T10:00:00.000Z",
        supportsTools: true,
        digest: digest("t1"),
      },
      {
        serverId: "vps",
        label: "VPS",
        online: true,
        lastSeenAt: "2026-10-09T10:00:00.000Z",
        supportsTools: false,
        digest: null,
      },
    ]);
  });

  it("keeps the last digest and sighting of a host that went offline", () => {
    const first = rememberFleetHosts({
      previous: new Map(),
      hosts: [mini],
      digests: new Map([["mini", digest("t1")]]),
      now: "2026-10-09T10:00:00.000Z",
    });
    const offlineMini = { ...mini, isConnected: false };
    const second = rememberFleetHosts({
      previous: first,
      hosts: [offlineMini],
      digests: new Map(),
      now: "2026-10-09T10:00:05.000Z",
    });

    expect(buildFleetHostStates({ hosts: [offlineMini], remembered: second })).toEqual([
      {
        serverId: "mini",
        label: "Mac mini",
        online: false,
        lastSeenAt: "2026-10-09T10:00:00.000Z",
        supportsTools: true,
        digest: digest("t1"),
      },
    ]);
  });

  it("keeps the last digest when a connected host fails to answer", () => {
    const first = rememberFleetHosts({
      previous: new Map(),
      hosts: [mini],
      digests: new Map([["mini", digest("t1")]]),
      now: "2026-10-09T10:00:00.000Z",
    });
    const second = rememberFleetHosts({
      previous: first,
      hosts: [mini],
      digests: new Map(),
      now: "2026-10-09T10:00:05.000Z",
    });

    expect(second.get("mini")).toEqual({
      digest: digest("t1"),
      lastSeenAt: "2026-10-09T10:00:05.000Z",
    });
  });

  it("reports a host never seen during the call without a digest", () => {
    const offline = { ...mini, isConnected: false };

    expect(buildFleetHostStates({ hosts: [offline], remembered: new Map() })).toEqual([
      {
        serverId: "mini",
        label: "Mac mini",
        online: false,
        lastSeenAt: null,
        supportsTools: true,
        digest: null,
      },
    ]);
  });
});

describe("operation dedupe", () => {
  it("claims each operation once and forgets the oldest past its limit", () => {
    const dedupe = createOperationDedupe(2);

    expect([dedupe.claim("a"), dedupe.claim("a"), dedupe.claim("b"), dedupe.claim("c")]).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect([dedupe.claim("b"), dedupe.claim("c"), dedupe.claim("a")]).toEqual([false, false, true]);
  });
});

describe("fleet sync loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function recordRuns(durationMs: number) {
    const runs: number[] = [];
    const run = () => {
      runs.push(Date.now());
      return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    };
    return { runs, run };
  }

  it("runs at once, then every interval after the last run finished", async () => {
    vi.setSystemTime(0);
    const { runs, run } = recordRuns(100);
    const loop = createFleetSyncLoop({ run, intervalMs: 5_000, soonMs: 1_000 });

    loop.start();
    await vi.advanceTimersByTimeAsync(10_300);
    loop.stop();

    expect(runs).toEqual([0, 5_100, 10_200]);
  });

  it("pulls the next run forward after a change, coalescing a burst", async () => {
    vi.setSystemTime(0);
    const { runs, run } = recordRuns(0);
    const loop = createFleetSyncLoop({ run, intervalMs: 5_000, soonMs: 1_000 });

    loop.start();
    await vi.advanceTimersByTimeAsync(2_000);
    loop.requestSoon();
    await vi.advanceTimersByTimeAsync(500);
    loop.requestSoon();
    await vi.advanceTimersByTimeAsync(4_000);
    loop.stop();

    expect(runs).toEqual([0, 3_000]);
  });

  it("does not overlap runs and catches up right after a slow one", async () => {
    vi.setSystemTime(0);
    const { runs, run } = recordRuns(3_000);
    const loop = createFleetSyncLoop({ run, intervalMs: 5_000, soonMs: 1_000 });

    loop.start();
    await vi.advanceTimersByTimeAsync(500);
    loop.requestSoon();
    await vi.advanceTimersByTimeAsync(3_000);
    loop.stop();

    expect(runs).toEqual([0, 3_000]);
  });

  it("keeps running after a failed run and stays quiet once stopped", async () => {
    vi.setSystemTime(0);
    const runs: number[] = [];
    const loop = createFleetSyncLoop({
      run: async () => {
        runs.push(Date.now());
        throw new Error("host unreachable");
      },
      intervalMs: 5_000,
      soonMs: 1_000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(5_000);
    loop.stop();
    loop.requestSoon();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(runs).toEqual([0, 5_000]);
  });
});
