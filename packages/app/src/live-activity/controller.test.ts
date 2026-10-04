import { describe, expect, it } from "vitest";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { AgentsLiveActivity } from "./controller";
import type { LiveActivityNative } from "./native-types";
import type { LiveActivityLabels } from "./summary";

const labels: LiveActivityLabels = {
  headline: ({ working, waiting, finished }) => `${working}w ${waiting}p ${finished}f`,
  working: () => "working",
  waiting: () => "waiting",
  permission: "permission",
  finished: "finished",
  failed: "failed",
  untitled: "New session",
};

function agent(overrides: Partial<AgentDirectoryEntry> & { id: string }): AgentDirectoryEntry {
  return {
    serverId: "s1",
    title: overrides.id,
    status: "idle",
    lastActivityAt: new Date(0),
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    ...overrides,
  } as AgentDirectoryEntry;
}

function setup(options: { foreground?: boolean; running?: boolean } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const state = { now: 10_000, foreground: options.foreground ?? true };
  const native: LiveActivityNative = {
    isEnabled: () => true,
    isRunning: () => options.running ?? false,
    start: async (...args) => {
      calls.push(["start", ...args]);
    },
    update: async (...args) => {
      calls.push(["update", ...args]);
    },
    end: async (...args) => {
      calls.push(["end", ...args]);
    },
  };
  const activity = new AgentsLiveActivity({
    native,
    title: "Paseo",
    labels: () => labels,
    isForeground: () => state.foreground,
    now: () => state.now,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { activity, calls, state, settle };
}

describe("AgentsLiveActivity", () => {
  it("starts when an agent starts working, updates on change, ends showing the result", async () => {
    const { activity, calls, state, settle } = setup();
    activity.sync([agent({ id: "a", status: "running" })]);
    activity.sync([agent({ id: "a", status: "running" })]);
    state.now = 20_000;
    activity.sync([agent({ id: "a", status: "running" }), agent({ id: "b", status: "running" })]);
    state.now = 30_000;
    activity.sync([
      agent({
        id: "a",
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: new Date(25_000),
      }),
    ]);
    await settle();

    expect(calls.map(([name]) => name)).toEqual(["start", "update", "end"]);
    expect(JSON.parse(calls[0]?.[2] as string)).toMatchObject({ headline: "1w 0p 0f" });
    expect(JSON.parse(calls[1]?.[1] as string)).toMatchObject({ headline: "2w 0p 0f" });
    expect(JSON.parse(calls[2]?.[1] as string)).toMatchObject({ headline: "0w 0p 1f" });
    expect(calls[2]?.[2]).toBe(600);
  });

  it("waits for the foreground to start, since iOS only starts activities from it", async () => {
    const { activity, calls, state, settle } = setup({ foreground: false });
    activity.sync([agent({ id: "a", status: "running" })]);
    await settle();
    expect(calls).toEqual([]);

    state.foreground = true;
    activity.sync([agent({ id: "a", status: "running" })]);
    await settle();
    expect(calls.map(([name]) => name)).toEqual(["start"]);
  });

  it("clears an activity left over from a previous launch", async () => {
    const { calls, settle } = setup({ running: true });
    await settle();
    expect(calls).toEqual([["end", "", 0]]);
  });
});
