import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { formatAgentModelLabel, joinAgentModelLabel } from "./model-label";

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
      },
    ],
  },
  {
    provider: "claude-work",
    status: "ready",
    enabled: true,
    source: "custom",
    label: "claude-work",
    models: [{ provider: "claude-work", id: "claude-opus-5-5", label: "Opus 5.5" }],
  },
];

describe("formatAgentModelLabel", () => {
  it("names a builtin provider's model without an account", () => {
    expect(formatAgentModelLabel({ provider: "claude", model: "opus" }, ENTRIES)).toEqual({
      model: "Opus 5.5",
      account: null,
    });
  });

  it("adds the custom provider as the account", () => {
    const label = formatAgentModelLabel(
      { provider: "claude-work", model: "claude-opus-5-5" },
      ENTRIES,
    );
    expect(label).toEqual({ model: "Opus 5.5", account: "claude-work" });
    expect(joinAgentModelLabel(label)).toBe("Opus 5.5 · claude-work");
  });

  it("falls back to the raw id for a model the snapshot does not list", () => {
    expect(formatAgentModelLabel({ provider: "claude", model: "claude-next" }, ENTRIES)).toEqual({
      model: "claude-next",
      account: null,
    });
  });

  it("shows the raw id before the providers snapshot loads", () => {
    expect(
      joinAgentModelLabel(formatAgentModelLabel({ provider: "codex", model: "gpt-6" }, undefined)),
    ).toBe("gpt-6");
  });

  it("has no label without a model or an account", () => {
    expect(
      joinAgentModelLabel(formatAgentModelLabel({ provider: "codex", model: null }, ENTRIES)),
    ).toBeNull();
  });
});
