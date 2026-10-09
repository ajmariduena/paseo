import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudeRuntimeResidency } from "./runtime-residency.js";

function stopHook(backgroundTaskIds: string[], cronCount = 0, recurring?: boolean) {
  return {
    hook_event_name: "Stop",
    background_tasks: backgroundTaskIds.map((id) => ({ id, type: "shell", status: "running" })),
    session_crons: Array.from({ length: cronCount }, (_, index) => ({
      id: `cron-${index}`,
      ...(recurring === undefined ? {} : { schedule: "* * * * *", recurring, prompt: "poll" }),
    })),
  };
}

function tasksChanged(taskIds: string[]): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: taskIds.map((task_id) => ({ task_id, task_type: "local_bash", description: "" })),
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "session",
  } as SDKMessage;
}

describe("ClaudeRuntimeResidency", () => {
  it("retains a runtime until a Stop hook has reported its inventory", () => {
    const residency = new ClaudeRuntimeResidency();
    expect(residency.canRelease()).toBe(false);

    residency.observeMessage(tasksChanged([]));
    expect(residency.canRelease()).toBe(false);

    residency.observeStopHook(stopHook([]));
    expect(residency.canRelease()).toBe(true);
  });

  it("retains a runtime whose Stop hook predates the inventory fields", () => {
    const residency = new ClaudeRuntimeResidency();
    residency.observeStopHook({ hook_event_name: "Stop" });
    expect(residency.canRelease()).toBe(false);
  });

  it("retains a runtime with background tasks until they finish", () => {
    const residency = new ClaudeRuntimeResidency();
    residency.observeStopHook(stopHook(["shell-1"]));
    expect(residency.canRelease()).toBe(false);

    residency.observeMessage(tasksChanged(["shell-1", "monitor-1"]));
    expect(residency.canRelease()).toBe(false);

    residency.observeMessage(tasksChanged([]));
    expect(residency.canRelease()).toBe(true);
  });

  it("retains a runtime with session crons because they stop firing once it closes", () => {
    const residency = new ClaudeRuntimeResidency();
    residency.observeStopHook(stopHook([], 1));
    expect(residency.canRelease()).toBe(false);
  });

  it("retains a runtime that holds session-scoped permission grants", () => {
    const residency = new ClaudeRuntimeResidency();
    residency.observeStopHook(stopHook([]));
    residency.observePermissionUpdates([{ destination: "localSettings" }]);
    expect(residency.canRelease()).toBe(true);

    residency.observePermissionUpdates([{ destination: "session" }]);
    expect(residency.canRelease()).toBe(false);
  });

  it("names what holds the runtime so a caller can tell finite work from the rest", () => {
    const residency = new ClaudeRuntimeResidency();
    expect(residency.holds()).toEqual([{ kind: "inventory_unknown" }]);

    residency.observeStopHook(stopHook(["shell-1"], 1, true));
    expect(residency.holds()).toEqual([
      { kind: "background_work", taskIds: ["shell-1"] },
      { kind: "session_crons", count: 1, recurring: true },
    ]);

    residency.observeStopHook(stopHook([], 2, false));
    expect(residency.holds()).toEqual([{ kind: "session_crons", count: 2, recurring: false }]);

    residency.observeStopHook(stopHook([], 1));
    expect(residency.holds()).toEqual([{ kind: "session_crons", count: 1, recurring: null }]);

    residency.observeStopHook(stopHook([]));
    residency.observePermissionUpdates([{ destination: "session" }]);
    expect(residency.holds()).toEqual([{ kind: "session_permissions" }]);

    residency.reset();
    residency.observeMessage(tasksChanged(["monitor-1"]));
    expect(residency.holds()).toEqual([
      { kind: "background_work", taskIds: ["monitor-1"] },
      { kind: "inventory_unknown" },
    ]);
  });

  it("forgets everything when the CLI process restarts", () => {
    const residency = new ClaudeRuntimeResidency();
    residency.observeStopHook(stopHook([]));
    residency.observePermissionUpdates([{ destination: "session" }]);

    residency.reset();
    expect(residency.canRelease()).toBe(false);

    residency.observeStopHook(stopHook([]));
    expect(residency.canRelease()).toBe(true);
  });
});
