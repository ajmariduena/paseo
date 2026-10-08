import pino from "pino";
import { describe, expect, it } from "vitest";
import type { HostMetricsSnapshot } from "@getpaseo/protocol/host-metrics/types";
import { HostMetricsSession } from "./host-metrics-session.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";

const SNAPSHOT: HostMetricsSnapshot = {
  sampledAt: "2026-10-08T12:00:00.000Z",
  sampleIntervalMs: 2000,
  hostname: "studio.local",
  platform: "darwin",
  osLabel: "macOS 26.5.2",
  arch: "arm64",
  uptimeSeconds: 3600,
  cpu: { model: "Apple M5", cores: 10, percent: 12.5 },
  memory: { totalBytes: 100, usedBytes: 40, pressure: "normal" },
  disks: [{ mount: "/", name: "Macintosh HD", totalBytes: 1000, usedBytes: 600 }],
  history: { cpuPercent: [12.5], memoryPercent: [40] },
  processes: [{ pid: 1, name: "node", cpuPercent: 3, memoryBytes: 10, agentId: "agent-1" }],
};

function createSession(getSnapshot: () => Promise<HostMetricsSnapshot>) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new HostMetricsSession({
    host: { emit: (message) => emitted.push(message) },
    sampler: { getSnapshot },
    logger: pino({ level: "silent" }),
  });
  return { session, emitted };
}

describe("HostMetricsSession", () => {
  it("ignores messages that are not host metrics requests", () => {
    const { session, emitted } = createSession(async () => SNAPSHOT);
    expect(session.dispatch({ type: "ping", requestId: "p1" })).toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it("answers host.metrics.get.request with the sampler snapshot", async () => {
    const { session, emitted } = createSession(async () => SNAPSHOT);

    await session.dispatch({ type: "host.metrics.get.request", requestId: "m1" });

    expect(emitted).toEqual([
      { type: "host.metrics.get.response", payload: { requestId: "m1", metrics: SNAPSHOT } },
    ]);
  });

  it("reports a sampler failure as rpc_error", async () => {
    const { session, emitted } = createSession(async () => {
      throw new Error("sampler broke");
    });

    await session.dispatch({ type: "host.metrics.get.request", requestId: "m2" });

    expect(findByType(emitted, "rpc_error")?.payload).toEqual({
      requestId: "m2",
      requestType: "host.metrics.get.request",
      code: "host_metrics_failed",
      error: "sampler broke",
    });
  });
});
