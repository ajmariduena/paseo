import { describe, expect, it } from "vitest";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
} from "@getpaseo/protocol/provider-manifest";
import type { AgentMode } from "./agent-sdk-types.js";
import {
  resolveAndValidateCreateAgentMode,
  resolveDefaultAgentCreateConfig,
  withManifestModeMetadata,
} from "./create-agent-mode.js";

const CLAUDE_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
const OPENCODE_MODES = ["build", "plan"];
const CODEX_MODES = ["auto", "full-access"];

function agentParent(provider: string, modeId: string | null, isUnattended = false) {
  return { provider, modeId, isUnattended };
}

describe("resolveAndValidateCreateAgentMode", () => {
  it("returns the requested mode when it is valid for the target provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "plan",
      targetProvider: "opencode",
      parent: null,
      unattended: false,
      availableModes: OPENCODE_MODES,
    });
    expect(resolved).toBe("plan");
  });

  it("throws when the requested mode is invalid for the target provider", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: "bypassPermissions",
        targetProvider: "opencode",
        parent: null,
        unattended: false,
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "Invalid mode 'bypassPermissions' for provider 'opencode'. Available modes: build, plan",
    );
  });

  it("returns undefined (provider default) when no mode and no caller", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: null,
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBeUndefined();
  });

  it("inherits the caller mode when caller and target share a provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: agentParent("claude", "bypassPermissions"),
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBe("bypassPermissions");
  });

  it("returns undefined when same-provider caller has no mode", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: agentParent("claude", null),
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBeUndefined();
  });

  it("refuses cross-provider inheritance with the target provider's modes in the message", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "opencode",
        parent: agentParent("claude", "bypassPermissions"),
        unattended: false,
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "cannot inherit mode 'bypassPermissions' from caller (provider 'claude') for new agent (provider 'opencode'). Pass an explicit mode. Available modes for 'opencode': build, plan",
    );
  });

  it("refuses cross-provider inheritance even when the caller mode is null", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: agentParent("opencode", null),
        unattended: false,
        availableModes: CODEX_MODES,
      }),
    ).toThrow(
      "cannot inherit mode '<none>' from caller (provider 'opencode') for new agent (provider 'codex'). Pass an explicit mode. Available modes for 'codex': auto, full-access",
    );
  });

  it("uses the provider default when the cross-provider target has no modes", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: agentParent("codex", "auto"),
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });

    expect(resolved).toBeUndefined();
  });

  it("uses the provider default when an unattended parent targets a provider with no modes", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });

    expect(resolved).toBeUndefined();
  });

  it("passes through an explicit mode when the target provider's modes are unknown", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "default",
      targetProvider: "zai-custom",
      parent: null,
      unattended: false,
      availableModes: undefined,
    });
    expect(resolved).toBe("default");
  });

  it("renders 'unknown' in cross-provider error when target modes are unknown", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "zai-custom",
        parent: agentParent("claude", "default"),
        unattended: false,
        availableModes: undefined,
      }),
    ).toThrow("Available modes for 'zai-custom': unknown");
  });

  it("inherits target's unattended mode when caller is unattended cross-provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("full-access");
  });

  it("inherits target's unattended mode for unattended creation without a parent", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: null,
      unattended: true,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("full-access");
  });

  it("still refuses cross-provider inheritance from an attended caller when target mode metadata is unknown", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: agentParent("claude", "default"),
        unattended: false,
        availableModes: CODEX_MODES,
        targetUnattendedMode: "full-access",
      }),
    ).toThrow(
      "cannot inherit mode 'default' from caller (provider 'claude') for new agent (provider 'codex'). Pass an explicit mode. Available modes for 'codex': auto, full-access",
    );
  });

  it("still refuses cross-provider inheritance when target has no unattended mode", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "zai-custom",
        parent: agentParent("claude", "bypassPermissions", true),
        unattended: false,
        availableModes: undefined,
        targetUnattendedMode: undefined,
      }),
    ).toThrow(
      "cannot inherit mode 'bypassPermissions' from caller (provider 'claude') for new agent (provider 'zai-custom'). Pass an explicit mode. Available modes for 'zai-custom': unknown",
    );
  });

  it("explicit mode wins over unattended inheritance", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "auto",
      targetProvider: "codex",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("auto");
  });
});

function providerDefinition(id: string): AgentProviderDefinition {
  const definition = AGENT_PROVIDER_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`No provider definition for ${id}`);
  return definition;
}

function resolveChildMode(parentProvider: string, parentModeId: string, childProvider: string) {
  const mode = providerDefinition(parentProvider).modes.find((m) => m.id === parentModeId);
  if (!mode) throw new Error(`No mode ${parentModeId} for ${parentProvider}`);
  const child = providerDefinition(childProvider);
  return resolveDefaultAgentCreateConfig({
    provider: childProvider,
    requestedMode: undefined,
    featureValues: undefined,
    parent: {
      provider: parentProvider,
      modeId: parentModeId,
      isUnattended: mode.isUnattended === true,
      mode,
    },
    unattended: false,
    availableModes: child.modes,
    defaultModeId: child.defaultModeId,
  }).modeId;
}

function modeTier(mode: AgentMode | undefined): number {
  if (mode?.isUnattended || mode?.colorTier === "dangerous") return 2;
  if (mode?.colorTier === "planning") return 0;
  return 1;
}

const COPILOT_PLAN = "https://agentclientprotocol.com/protocol/session-modes#plan";
const COPILOT_AGENT = "https://agentclientprotocol.com/protocol/session-modes#agent";

describe("cross-provider mode inheritance by permission level", () => {
  it.each([
    ["claude", "plan", "opencode", "plan"],
    ["claude", "plan", "copilot", COPILOT_PLAN],
    ["claude", "default", "codex", "auto-review"],
    ["claude", "default", "omp", "ask"],
    ["claude", "default", "copilot", COPILOT_AGENT],
    ["claude", "default", "opencode", "build"],
    ["claude", "acceptEdits", "codex", "auto-review"],
    ["claude", "acceptEdits", "omp", "write"],
    ["claude", "auto", "codex", "auto"],
    ["claude", "bypassPermissions", "codex", "full-access"],
    ["claude", "bypassPermissions", "omp", "full"],
    ["claude", "bypassPermissions", "copilot", "allow-all"],
    ["claude", "bypassPermissions", "opencode", "build"],
    ["codex", "auto", "claude", "auto"],
    ["codex", "auto-review", "claude", "auto"],
    ["codex", "auto", "omp", "write"],
    ["codex", "full-access", "claude", "bypassPermissions"],
    ["omp", "ask", "claude", "default"],
    ["omp", "write", "claude", "auto"],
    ["omp", "full", "codex", "full-access"],
    ["opencode", "plan", "claude", "plan"],
    ["opencode", "build", "codex", "auto-review"],
    ["copilot", COPILOT_PLAN, "claude", "plan"],
    ["copilot", COPILOT_AGENT, "claude", "auto"],
  ])("%s %s creates a %s child in %s", (parentProvider, parentMode, childProvider, expected) => {
    expect(resolveChildMode(parentProvider, parentMode, childProvider)).toBe(expected);
  });

  it.each([
    ["claude", "plan", "codex"],
    ["claude", "plan", "omp"],
    ["opencode", "plan", "codex"],
  ])("refuses %s %s for a %s child that has no planning mode", (parent, mode, child) => {
    expect(() => resolveChildMode(parent, mode, child)).toThrow("Pass an explicit mode");
  });

  it("never picks a child mode above the parent's tier", () => {
    const definitions = AGENT_PROVIDER_DEFINITIONS.filter((d) => d.modes.length > 0);
    for (const parent of definitions) {
      for (const parentMode of parent.modes) {
        for (const child of definitions) {
          if (child.id === parent.id) continue;
          let childModeId: string | undefined;
          try {
            childModeId = resolveChildMode(parent.id, parentMode.id, child.id);
          } catch {
            continue;
          }
          const childMode = child.modes.find((m) => m.id === childModeId);
          expect(
            modeTier(childMode),
            `${parent.id}/${parentMode.id} -> ${child.id}/${childModeId}`,
          ).toBeLessThanOrEqual(modeTier(parentMode));
        }
      }
    }
  });

  it("gives an unattended parent the child's default when the child has no unattended mode", () => {
    const resolved = resolveDefaultAgentCreateConfig({
      provider: "custom",
      requestedMode: undefined,
      featureValues: undefined,
      parent: { provider: "claude", modeId: "bypassPermissions", isUnattended: true },
      unattended: false,
      availableModes: [
        { id: "think", label: "Think", colorTier: "planning" },
        { id: "careful", label: "Careful", colorTier: "safe" },
        { id: "edit", label: "Edit", colorTier: "moderate" },
      ],
      defaultModeId: "careful",
    });
    expect(resolved.modeId).toBe("careful");
  });

  it("keeps an explicit mode over the mapped one", () => {
    const child = providerDefinition("codex");
    const resolved = resolveDefaultAgentCreateConfig({
      provider: "codex",
      requestedMode: "auto",
      featureValues: undefined,
      parent: { provider: "claude", modeId: "bypassPermissions", isUnattended: true },
      unattended: false,
      availableModes: child.modes,
      defaultModeId: child.defaultModeId,
    });
    expect(resolved.modeId).toBe("auto");
  });
});

describe("withManifestModeMetadata", () => {
  it("fills in tier and unattended flags that runtime modes don't report", () => {
    const definition = providerDefinition("claude");
    const decorated = withManifestModeMetadata(
      [
        { id: "bypassPermissions", label: "Bypass" },
        { id: "custom", label: "Custom" },
      ],
      definition.modes,
    );
    expect(decorated).toEqual([
      {
        id: "bypassPermissions",
        label: "Bypass",
        icon: "ShieldOff",
        colorTier: "dangerous",
        isUnattended: true,
      },
      { id: "custom", label: "Custom" },
    ]);
  });
});
