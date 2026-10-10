import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  formatAgentModelLabel,
  joinAgentModelLabel,
  resolveAgentModelLabelInput,
} from "./model-label";

const ENTRIES: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    source: "builtin",
    label: "Claude",
    models: [
      {
        provider: "claude",
        id: "claude-opus-5-5",
        aliases: ["opus"],
        label: "Opus 5.5",
        thinkingOptions: [
          { id: "high", label: "High", isDefault: true },
          { id: "max", label: "Max" },
        ],
      },
    ],
  },
  {
    provider: "claude-work",
    status: "ready",
    enabled: true,
    source: "custom",
    label: "claude-work",
    models: [
      {
        provider: "claude-work",
        id: "claude-opus-5-5",
        label: "Opus 5.5",
        thinkingOptions: [{ id: "max", label: "Max" }],
      },
    ],
  },
];

function label(input: { provider: string; model: string | null; thinkingOptionId?: string }) {
  return formatAgentModelLabel({ thinkingOptionId: null, ...input }, ENTRIES);
}

describe("formatAgentModelLabel", () => {
  it("names a builtin provider's model without an account", () => {
    expect(label({ provider: "claude", model: "opus" })).toEqual({
      model: "Opus 5.5",
      effort: null,
      account: null,
    });
  });

  it("adds the custom provider as the account", () => {
    const result = label({ provider: "claude-work", model: "claude-opus-5-5" });
    expect(result).toEqual({ model: "Opus 5.5", effort: null, account: "claude-work" });
    expect(joinAgentModelLabel(result)).toBe("Opus 5.5 · claude-work");
  });

  it("puts the effort after the model and before the account, as the composer does", () => {
    const result = label({
      provider: "claude-work",
      model: "claude-opus-5-5",
      thinkingOptionId: "max",
    });
    expect(result).toEqual({ model: "Opus 5.5", effort: "Max", account: "claude-work" });
    expect(joinAgentModelLabel(result)).toBe("Opus 5.5 Max · claude-work");
  });

  it("labels an effort the model does not list from its id", () => {
    expect(
      joinAgentModelLabel(label({ provider: "codex", model: "gpt-6", thinkingOptionId: "xhigh" })),
    ).toBe("gpt-6 Extra high");
  });

  it("shows no effort for the default option", () => {
    expect(label({ provider: "claude", model: "opus", thinkingOptionId: "default" }).effort).toBe(
      null,
    );
  });

  it("falls back to the raw id for a model the snapshot does not list", () => {
    expect(label({ provider: "claude", model: "claude-next" })).toEqual({
      model: "claude-next",
      effort: null,
      account: null,
    });
  });

  it("shows the raw id before the providers snapshot loads", () => {
    expect(
      joinAgentModelLabel(
        formatAgentModelLabel(
          { provider: "codex", model: "gpt-6", thinkingOptionId: null },
          undefined,
        ),
      ),
    ).toBe("gpt-6");
  });

  it("has no label without a model or an account", () => {
    expect(joinAgentModelLabel(label({ provider: "codex", model: null }))).toBeNull();
  });
});

describe("resolveAgentModelLabelInput", () => {
  it("prefers what the runtime reports over the configured model and effort", () => {
    expect(
      resolveAgentModelLabelInput({
        provider: "claude",
        model: "opus",
        thinkingOptionId: "high",
        runtimeInfo: { model: "claude-opus-5-5", thinkingOptionId: "max" },
      }),
    ).toEqual({ provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "max" });
  });

  it("keeps the configured effort when the runtime reports none", () => {
    expect(
      resolveAgentModelLabelInput({ provider: "claude", model: "opus", thinkingOptionId: "high" }),
    ).toEqual({ provider: "claude", model: "opus", thinkingOptionId: "high" });
  });
});
