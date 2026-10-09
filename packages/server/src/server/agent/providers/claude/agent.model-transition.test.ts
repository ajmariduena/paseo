import { expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

async function createSession(config: Partial<AgentSessionConfig> = {}) {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
  });
  return client.createSession({ provider: "claude", cwd: process.cwd(), ...config });
}

test.each([
  ["a model change", { model: "claude-sonnet-5-5" }, { kind: "in_session" }],
  ["clearing the model", { model: null }, { kind: "in_session" }],
  ["a mode change", { modeId: "acceptEdits" }, { kind: "in_session" }],
  ["the same thinking option", { thinkingOptionId: "high" }, { kind: "in_session" }],
  ["a thinking change", { thinkingOptionId: "max" }, { kind: "restart_session" }],
  ["clearing thinking", { thinkingOptionId: null }, { kind: "restart_session" }],
  [
    "fast mode on a model that supports it",
    { featureValues: { fast_mode: true } },
    { kind: "in_session" },
  ],
  [
    "fast mode on a model that does not support it",
    { model: "claude-sonnet-5-5", featureValues: { fast_mode: true } },
    { kind: "reject", reason: "Claude fast mode is not available for model 'claude-sonnet-5-5'" },
  ],
  [
    "an unknown feature",
    { featureValues: { turbo: true } },
    { kind: "reject", reason: "Unknown Claude feature: turbo" },
  ],
  [
    "an unknown thinking option",
    { thinkingOptionId: "ultra" },
    { kind: "reject", reason: "Unknown thinking option: ultra" },
  ],
  [
    "disabling thinking on a model that cannot",
    { model: "claude-opus-5-5", thinkingOptionId: "off" },
    {
      kind: "reject",
      reason: "Thinking option 'off' is not available for model 'claude-opus-5-5'",
    },
  ],
  [
    "an invalid mode",
    { modeId: "yolo" },
    { kind: "reject", reason: "Invalid mode 'yolo' for Claude provider" },
  ],
])("classifies %s on an Opus session", async (_label, change, expected) => {
  const session = await createSession({ model: "claude-opus-5-5", thinkingOptionId: "high" });
  try {
    expect(session.planModelTransition?.(change)).toEqual(expected);
  } finally {
    await session.close();
  }
});

test("moving a disabled-thinking session to a model that cannot disable thinking relaunches it", async () => {
  const session = await createSession({ model: "claude-opus-5", thinkingOptionId: "off" });
  try {
    expect(session.planModelTransition?.({ model: "claude-opus-5-5" })).toEqual({
      kind: "restart_session",
    });
    expect(session.planModelTransition?.({ model: "claude-sonnet-5" })).toEqual({
      kind: "in_session",
    });
  } finally {
    await session.close();
  }
});

test("a session with fast mode on rejects a model that cannot run it", async () => {
  const session = await createSession({
    model: "claude-opus-5-5",
    featureValues: { fast_mode: true },
  });
  try {
    expect(session.planModelTransition?.({ model: "claude-sonnet-5-5" })).toEqual({
      kind: "reject",
      reason: "Claude fast mode is not available for model 'claude-sonnet-5-5'",
    });
    expect(
      session.planModelTransition?.({
        model: "claude-sonnet-5-5",
        featureValues: { fast_mode: false },
      }),
    ).toEqual({ kind: "in_session" });
  } finally {
    await session.close();
  }
});
