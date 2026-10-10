import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { expect, test } from "vitest";

import type { AgentMode, AgentModelDefinition } from "../agent-sdk-types.js";
import type { SerializableAgentConfig } from "../agent-storage.js";
import { planTargetConfig, type SwitchSource, type SwitchTarget } from "./target-config.js";

const CLAUDE_MODES: AgentMode[] = [
  { id: "plan", label: "Plan Mode", colorTier: "planning" },
  { id: "default", label: "Always Ask", colorTier: "safe" },
  { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
  { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous", isUnattended: true },
];

const CODEX_MODES: AgentMode[] = [
  { id: "auto", label: "Default Permissions", colorTier: "moderate" },
  { id: "auto-review", label: "Auto-review", colorTier: "moderate" },
  { id: "full-access", label: "Full Access", colorTier: "dangerous", isUnattended: true },
];

const CODEX_WITH_READ_ONLY: AgentMode[] = [
  { id: "read-only", label: "Read Only", colorTier: "safe" },
  ...CODEX_MODES,
];

function model(
  provider: string,
  id: string,
  extra: Partial<AgentModelDefinition> = {},
): AgentModelDefinition {
  return { provider, id, label: id, ...extra };
}

const CLAUDE_MODELS = [
  model("claude", "claude-opus-5-5", {
    isDefault: true,
    thinkingOptions: [
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
    ],
  }),
  model("claude", "claude-sonnet-5-5"),
];
const CODEX_MODELS = [
  model("codex", "gpt-5.4", {
    isDefault: true,
    thinkingOptions: [{ id: "xhigh", label: "Extra" }],
  }),
  model("codex", "gpt-5.4-mini"),
];

function claudeSource(config: Partial<SerializableAgentConfig> = {}): SwitchSource {
  return {
    provider: "claude",
    driver: "claude",
    config: { modeId: "default", model: "claude-opus-5-5", thinkingOptionId: "high", ...config },
    modes: CLAUDE_MODES,
  };
}

function codexSource(config: Partial<SerializableAgentConfig> = {}): SwitchSource {
  return {
    provider: "codex",
    driver: "codex",
    config: {
      modeId: "auto",
      model: "gpt-5.4",
      featureValues: { service_tier: "fast" },
      ...config,
    },
    modes: CODEX_MODES,
  };
}

function codexTarget(overrides: Partial<SwitchTarget> = {}): SwitchTarget {
  return {
    provider: "codex",
    driver: "codex",
    models: CODEX_MODELS,
    modes: CODEX_MODES,
    defaultModeId: "auto",
    featureIds: ["service_tier", "plan_mode"],
    supportsMcpServers: true,
    appliesToolPolicy: true,
    ...overrides,
  };
}

function claudeTarget(overrides: Partial<SwitchTarget> = {}): SwitchTarget {
  return {
    provider: "claude",
    driver: "claude",
    models: CLAUDE_MODELS,
    modes: CLAUDE_MODES,
    defaultModeId: "default",
    featureIds: ["fast_mode"],
    supportsMcpServers: true,
    appliesToolPolicy: true,
    ...overrides,
  };
}

test("Always Ask never maps to a Codex mode that edits on its own; the picker has to ask", () => {
  const plan = planTargetConfig({ source: claudeSource(), target: codexTarget(), request: {} });

  expect(plan).toEqual({
    status: "rejected",
    rejection: {
      kind: "mode_required",
      reason: "broader",
      candidates: ["auto", "auto-review", "full-access"],
    },
  });
});

test("an explicit target mode is the user's answer and is taken as given", () => {
  const plan = planTargetConfig({
    source: claudeSource(),
    target: codexTarget(),
    request: { modeId: "auto-review" },
  });

  expect(plan).toMatchObject({
    status: "resolved",
    target: { provider: "codex", config: { modeId: "auto-review", model: "gpt-5.4" } },
  });
});

test("an equal-or-narrower authority maps on its own", () => {
  const narrower = planTargetConfig({
    source: claudeSource(),
    target: codexTarget({ modes: CODEX_WITH_READ_ONLY }),
    request: {},
  });
  expect(narrower).toMatchObject({
    status: "resolved",
    target: { config: { modeId: "read-only" } },
  });

  const equal = planTargetConfig({
    source: claudeSource({ modeId: "acceptEdits" }),
    target: codexTarget(),
    request: {},
  });
  expect(equal).toMatchObject({ status: "resolved", target: { config: { modeId: "auto" } } });

  const unattended = planTargetConfig({
    source: claudeSource({ modeId: "bypassPermissions" }),
    target: codexTarget(),
    request: {},
  });
  expect(unattended).toMatchObject({
    status: "resolved",
    target: { config: { modeId: "full-access" } },
  });
});

test("planning maps both ways: Claude plan becomes Codex plan_mode on a narrow mode, and back", () => {
  const toCodexWithoutNarrowMode = planTargetConfig({
    source: claudeSource({ modeId: "plan" }),
    target: codexTarget(),
    request: {},
  });
  expect(toCodexWithoutNarrowMode).toEqual({
    status: "rejected",
    rejection: {
      kind: "mode_required",
      reason: "unmappable",
      candidates: ["auto", "auto-review", "full-access"],
    },
  });

  const toCodex = planTargetConfig({
    source: claudeSource({ modeId: "plan" }),
    target: codexTarget({ modes: CODEX_WITH_READ_ONLY }),
    request: {},
  });
  expect(toCodex).toMatchObject({
    status: "resolved",
    target: { config: { modeId: "read-only", featureValues: { plan_mode: true } } },
  });

  const toClaude = planTargetConfig({
    source: codexSource({ featureValues: { plan_mode: true, service_tier: "fast" } }),
    target: claudeTarget(),
    request: {},
  });
  expect(toClaude).toMatchObject({
    status: "resolved",
    target: { config: { modeId: "plan", model: "claude-opus-5-5" } },
  });
  expect(toClaude.status === "resolved" && toClaude.target.config.featureValues).toBeUndefined();
});

test("models must exist in the target alias catalog; a different driver takes the target default", () => {
  const defaulted = planTargetConfig({
    source: claudeSource({ modeId: "acceptEdits" }),
    target: codexTarget(),
    request: {},
  });
  expect(defaulted).toMatchObject({
    status: "resolved",
    target: { config: { model: "gpt-5.4" }, droppedThinkingOptionId: null },
  });

  const pinnedElsewhere = planTargetConfig({
    source: claudeSource({ modeId: "acceptEdits" }),
    target: codexTarget(),
    request: { model: "gpt-5.4-work-only" },
  });
  expect(pinnedElsewhere).toEqual({
    status: "rejected",
    rejection: { kind: "model_unavailable", model: "gpt-5.4-work-only" },
  });

  const aliased = planTargetConfig({
    source: claudeSource({ modeId: "acceptEdits" }),
    target: codexTarget({ models: [model("codex", "gpt-5.4", { aliases: ["gpt-5.4-latest"] })] }),
    request: { model: "gpt-5.4-latest" },
  });
  expect(aliased).toMatchObject({ status: "resolved", target: { config: { model: "gpt-5.4" } } });
});

test("thinking and features are resolved per target model, never carried blindly", () => {
  const plan = planTargetConfig({
    source: claudeSource({ modeId: "acceptEdits", featureValues: { fast_mode: true } }),
    target: codexTarget(),
    request: { thinkingOptionId: "xhigh" },
  });
  expect(plan).toMatchObject({
    status: "resolved",
    target: {
      config: { thinkingOptionId: "xhigh" },
      droppedFeatureIds: ["fast_mode"],
      droppedThinkingOptionId: null,
    },
  });

  const unknownThinking = planTargetConfig({
    source: claudeSource({ modeId: "acceptEdits" }),
    target: codexTarget(),
    request: { thinkingOptionId: "ultra" },
  });
  expect(unknownThinking).toMatchObject({
    status: "resolved",
    target: { config: { thinkingOptionId: undefined }, droppedThinkingOptionId: "ultra" },
  });
});

test("tool policies and user MCP servers reject targets that cannot honor them", () => {
  const toolPolicy = { preapproved: [{ kind: "mcp" as const, server: "paseo", tool: "notes" }] };
  expect(
    planTargetConfig({
      source: claudeSource({ toolPolicy }),
      target: codexTarget({ appliesToolPolicy: false }),
      request: {},
    }),
  ).toEqual({ status: "rejected", rejection: { kind: "tool_policy_unsupported" } });
  expect(
    planTargetConfig({
      source: claudeSource({ mcpServers: { linear: { command: "linear-mcp" } } }),
      target: codexTarget({ supportsMcpServers: false }),
      request: {},
    }),
  ).toEqual({ status: "rejected", rejection: { kind: "mcp_servers_unsupported" } });
});

test("provider options reset across drivers and carry within one", () => {
  const across = planTargetConfig({
    source: claudeSource({ modeId: "acceptEdits", providerOptions: { effort: "max" } }),
    target: codexTarget(),
    request: {},
  });
  expect(across.status === "resolved" && across.target.config.providerOptions).toBeUndefined();

  const within = planTargetConfig({
    source: codexSource({ providerOptions: { sandbox_mode: "workspace-write" } }),
    target: codexTarget({ provider: "codex-work" }),
    request: {},
  });
  expect(within).toMatchObject({
    status: "resolved",
    target: {
      provider: "codex-work",
      config: { providerOptions: { sandbox_mode: "workspace-write" }, model: "gpt-5.4" },
      transition: "new_segment",
    },
  });
});

function manifestModes(provider: string): AgentMode[] {
  const definition = getAgentProviderDefinition(provider);
  if (!definition) throw new Error(`no manifest for ${provider}`);
  return definition.modes.map((mode) => Object.assign({}, mode));
}

test("a Codex read-only sandbox override narrows the effective authority before mapping", () => {
  const source: SwitchSource = {
    provider: "codex",
    driver: "codex",
    config: { modeId: "auto", model: "gpt-5.4", providerOptions: { sandbox_mode: "read-only" } },
    modes: manifestModes("codex"),
  };
  const target = claudeTarget({ modes: manifestModes("claude") });

  const plan = planTargetConfig({ source, target, request: {} });

  // Read-only never writes; Always Ask writes after approval. Only a non-writing mode keeps it.
  expect(plan).toMatchObject({ status: "resolved", target: { config: { modeId: "plan" } } });
  expect(plan.status === "resolved" && plan.target.config.providerOptions).toBeUndefined();
  expect(plan.status === "resolved" && plan.target.config.featureValues).toBeUndefined();

  const noNonWritingMode = planTargetConfig({
    source,
    target: claudeTarget({
      modes: CLAUDE_MODES.filter(
        (mode) => mode.colorTier !== "safe" && mode.colorTier !== "planning",
      ),
    }),
    request: {},
  });
  expect(noNonWritingMode).toEqual({
    status: "rejected",
    rejection: {
      kind: "mode_required",
      reason: "broader",
      candidates: ["acceptEdits", "bypassPermissions"],
    },
  });

  // Within the driver the override travels with the config, so the mode maps by its own tier.
  const sameDriverAlias = planTargetConfig({
    source,
    target: codexTarget({ provider: "codex-work", modes: manifestModes("codex") }),
    request: {},
  });
  expect(sameDriverAlias).toMatchObject({
    status: "resolved",
    target: { config: { modeId: "auto", providerOptions: { sandbox_mode: "read-only" } } },
  });

  const withoutOverride = planTargetConfig({
    source: { ...source, config: { modeId: "auto", model: "gpt-5.4" } },
    target,
    request: {},
  });
  expect(withoutOverride).toMatchObject({
    status: "resolved",
    target: { config: { modeId: "auto" } },
  });

  const planning = planTargetConfig({
    source: {
      provider: "claude",
      driver: "claude",
      config: { modeId: "plan", model: "claude-opus-5-5" },
      modes: manifestModes("claude"),
    },
    target: codexTarget({ modes: manifestModes("codex") }),
    request: {},
  });
  expect(planning).toEqual({
    status: "rejected",
    rejection: {
      kind: "mode_required",
      reason: "unmappable",
      candidates: ["auto", "auto-review", "full-access"],
    },
  });
});

test("a restriction the target cannot keep below its narrowest mode asks for a mode", () => {
  const plan = planTargetConfig({
    source: {
      provider: "codex",
      driver: "codex",
      config: { modeId: "auto", model: "gpt-5.4", providerOptions: { sandbox_mode: "read-only" } },
      modes: manifestModes("codex"),
    },
    target: claudeTarget({
      modes: CLAUDE_MODES.filter(
        (mode) => mode.colorTier !== "safe" && mode.colorTier !== "planning",
      ),
    }),
    request: {},
  });

  expect(plan).toEqual({
    status: "rejected",
    rejection: {
      kind: "mode_required",
      reason: "broader",
      candidates: ["acceptEdits", "bypassPermissions"],
    },
  });
});

test("an alias change takes the target alias default model unless one was requested", () => {
  const workAlias = claudeTarget({
    provider: "claude-work",
    models: [model("claude-work", "claude-sonnet-5-5", { isDefault: true })],
  });

  const omitted = planTargetConfig({
    source: claudeSource({ thinkingOptionId: "high" }),
    target: workAlias,
    request: {},
  });
  expect(omitted).toMatchObject({
    status: "resolved",
    target: {
      provider: "claude-work",
      config: { model: "claude-sonnet-5-5", thinkingOptionId: undefined },
      transition: "new_segment",
    },
  });

  const requested = planTargetConfig({
    source: claudeSource(),
    target: workAlias,
    request: { model: "claude-opus-5-5" },
  });
  expect(requested).toEqual({
    status: "rejected",
    rejection: { kind: "model_unavailable", model: "claude-opus-5-5" },
  });

  const sameAlias = planTargetConfig({
    source: claudeSource(),
    target: claudeTarget({ models: CLAUDE_MODELS.toReversed() }),
    request: {},
  });
  expect(sameAlias).toMatchObject({
    status: "resolved",
    target: { config: { model: "claude-opus-5-5", thinkingOptionId: "high" } },
  });
});

test("a same-alias change is classified by the live session and can be rejected by it", () => {
  const inSession = planTargetConfig({
    source: codexSource(),
    target: codexTarget({ planModelTransition: () => ({ kind: "in_session" }) }),
    request: { model: "gpt-5.4-mini" },
  });
  expect(inSession).toMatchObject({ status: "resolved", target: { transition: "in_session" } });

  const rejected = planTargetConfig({
    source: codexSource(),
    target: codexTarget({
      planModelTransition: () => ({ kind: "reject", reason: "no fast tier" }),
    }),
    request: { model: "gpt-5.4-mini" },
  });
  expect(rejected).toEqual({
    status: "rejected",
    rejection: { kind: "transition_rejected", reason: "no fast tier" },
  });

  const unclassified = planTargetConfig({
    source: codexSource(),
    target: codexTarget(),
    request: {},
  });
  expect(unclassified).toMatchObject({
    status: "resolved",
    target: { transition: "restart_session" },
  });
});
