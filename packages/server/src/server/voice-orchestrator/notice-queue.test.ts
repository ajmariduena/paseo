import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceNoticeQueue, type VoiceNotice } from "./notice-queue.js";

function createQueue(
  overrides: { busy?: () => boolean; stale?: (notice: VoiceNotice) => boolean } = {},
) {
  const delivered: VoiceNotice[][] = [];
  const queue = new VoiceNoticeQueue({
    batchWindowMs: 4_000,
    urgentDelayMs: 500,
    busyRetryMs: 1_000,
    isBusy: overrides.busy ?? (() => false),
    isStale: overrides.stale ?? (() => false),
    deliver: async (notices) => {
      delivered.push(notices);
    },
  });
  return { queue, delivered };
}

describe("VoiceNoticeQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("groups finished agents that land inside the batch window", async () => {
    const { queue, delivered } = createQueue();
    queue.push({ agentId: "a", reason: "finished" });
    await vi.advanceTimersByTimeAsync(2_000);
    queue.push({ agentId: "b", reason: "finished" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([
      [
        { agentId: "a", reason: "finished" },
        { agentId: "b", reason: "finished" },
      ],
    ]);
  });

  it("announces permissions quickly and ahead of finished work", async () => {
    const { queue, delivered } = createQueue();
    queue.push({ agentId: "done", reason: "finished" });
    queue.push({ agentId: "error", reason: "error" });
    queue.push({ agentId: "asks", reason: "permission" });
    await vi.advanceTimersByTimeAsync(500);
    expect(delivered).toEqual([
      [
        { agentId: "asks", reason: "permission" },
        { agentId: "error", reason: "error" },
        { agentId: "done", reason: "finished" },
      ],
    ]);
  });

  it("waits while the conversation is busy", async () => {
    let busy = true;
    const { queue, delivered } = createQueue({ busy: () => busy });
    queue.push({ agentId: "a", reason: "permission" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(delivered).toEqual([]);
    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toEqual([[{ agentId: "a", reason: "permission" }]]);
  });

  it("drops a notice that went stale before it was spoken", async () => {
    const { queue, delivered } = createQueue({ stale: (notice) => notice.agentId === "restarted" });
    queue.push({ agentId: "restarted", reason: "finished" });
    queue.push({ agentId: "kept", reason: "finished" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(delivered).toEqual([[{ agentId: "kept", reason: "finished" }]]);
  });

  it("keeps the most urgent reason per agent", async () => {
    const { queue, delivered } = createQueue();
    queue.push({ agentId: "a", reason: "permission" });
    queue.push({ agentId: "a", reason: "finished" });
    await vi.advanceTimersByTimeAsync(500);
    expect(delivered).toEqual([[{ agentId: "a", reason: "permission" }]]);
  });

  it("stops announcing after close", async () => {
    const { queue, delivered } = createQueue();
    queue.push({ agentId: "a", reason: "permission" });
    queue.close();
    queue.push({ agentId: "b", reason: "permission" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toEqual([]);
  });
});
