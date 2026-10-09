import { expect, test } from "vitest";

import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

async function createConnectedSession(): Promise<CodexAppServerAgentSession> {
  const appServer = createFakeCodexAppServer({
    "model/list": () => ({
      data: [
        {
          id: "gpt-5.4",
          isDefault: true,
          defaultReasoningEffort: "medium",
          serviceTiers: [{ id: "fast", name: "Fast", description: "Priority processing" }],
        },
        { id: "gpt-5.4-mini", defaultReasoningEffort: "medium" },
      ],
    }),
  });
  const config: AgentSessionConfig = {
    provider: "codex",
    cwd: "/workspace/project",
    modeId: "auto",
    model: "gpt-5.4",
  };
  const session = new CodexAppServerAgentSession(config, null, createTestLogger(), async () => {
    return appServer.child;
  });
  await session.connect();
  return session;
}

test.each([
  ["a model change", { model: "gpt-5.4-mini" }, { kind: "in_session" }],
  ["clearing the model", { model: null }, { kind: "in_session" }],
  ["a mode change", { modeId: "full-access" }, { kind: "in_session" }],
  ["a thinking change", { thinkingOptionId: "xhigh" }, { kind: "in_session" }],
  ["plan mode", { featureValues: { plan_mode: true } }, { kind: "in_session" }],
  [
    "fast mode on a model with a fast tier",
    { featureValues: { fast_mode: true } },
    { kind: "in_session" },
  ],
  [
    "the fast tier on a model that has it",
    { featureValues: { service_tier: "fast" } },
    { kind: "in_session" },
  ],
  [
    "the default tier",
    { model: "gpt-5.4-mini", featureValues: { service_tier: "default" } },
    { kind: "in_session" },
  ],
  [
    "fast mode on a model without a fast tier",
    { model: "gpt-5.4-mini", featureValues: { fast_mode: true } },
    { kind: "reject", reason: "Codex fast mode is not available for model 'gpt-5.4-mini'" },
  ],
  [
    "a tier the model lacks",
    { model: "gpt-5.4-mini", featureValues: { service_tier: "fast" } },
    { kind: "reject", reason: "Codex speed 'fast' is not available for model 'gpt-5.4-mini'" },
  ],
  [
    "an unknown feature",
    { featureValues: { turbo: true } },
    { kind: "reject", reason: "Unknown Codex feature: turbo" },
  ],
  [
    "an invalid mode",
    { modeId: "yolo" },
    {
      kind: "reject",
      reason:
        'Invalid Codex mode "yolo". Valid modes are: read-only, auto, auto-review, full-access',
    },
  ],
])("classifies %s", async (_label, change, expected) => {
  const session = await createConnectedSession();
  try {
    expect(session.planModelTransition(change)).toEqual(expected);
  } finally {
    await session.close();
  }
});
