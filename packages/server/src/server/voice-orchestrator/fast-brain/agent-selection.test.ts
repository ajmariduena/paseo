import { describe, expect, it } from "vitest";
import { resolveAgentSelection, type SelectableModel } from "./agent-selection.js";

const efforts = (ids: string[]) => ids.map((id) => ({ id, label: id }));
const claudeEfforts = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  { id: "ultracode", label: "Ultra Code" },
];

const catalog: Record<string, SelectableModel[]> = {
  claude: [
    {
      provider: "claude",
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      isDefault: true,
      thinkingOptions: claudeEfforts,
    },
    { provider: "claude", id: "claude-opus-5", label: "Opus 5", thinkingOptions: claudeEfforts },
    {
      provider: "claude",
      id: "claude-fable-5-1",
      label: "Fable 5.1",
      thinkingOptions: claudeEfforts,
    },
    { provider: "claude", id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  codex: [
    {
      provider: "codex",
      id: "gpt-6-astra",
      label: "GPT-6-Astra",
      thinkingOptions: efforts(["low", "medium", "high", "xhigh", "max", "ultra"]),
    },
    {
      provider: "codex",
      id: "gpt-6-sol",
      label: "GPT-6-Sol",
      isDefault: true,
      thinkingOptions: efforts(["low", "medium", "high", "xhigh", "max", "ultra"]),
    },
    {
      provider: "codex",
      id: "gpt-6-luna",
      label: "GPT-6-Luna",
      thinkingOptions: efforts(["low", "medium", "high", "xhigh", "max"]),
    },
  ],
};

describe("resolveAgentSelection", () => {
  it("maps 'Astra' and 'extra high' to codex gpt-6-astra at xhigh", () => {
    expect(
      resolveAgentSelection({
        request: { model: "Astra", effort: "extra high" },
        defaults: {},
        catalog,
      }),
    ).toEqual({ ok: true, provider: "codex", model: "gpt-6-astra", thinking: "xhigh" });
  });

  it("maps 'Opus 5.5' and 'ultra code' to claude-opus-5-5 at ultracode", () => {
    expect(
      resolveAgentSelection({
        request: { model: "Opus 5.5", effort: "ultra code" },
        defaults: {},
        catalog,
      }),
    ).toEqual({ ok: true, provider: "claude", model: "claude-opus-5-5", thinking: "ultracode" });
  });

  it("maps 'ultra' on Astra to its ultra option", () => {
    const result = resolveAgentSelection({
      request: { model: "astra", effort: "ultra code" },
      defaults: {},
      catalog,
    });
    expect(result).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-6-astra",
      thinking: "ultra",
    });
  });

  it("refuses an effort the model doesn't have instead of falling back", () => {
    const result = resolveAgentSelection({
      request: { model: "luna", effort: "ultra code" },
      defaults: {},
      catalog,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("GPT-6-Luna");
  });

  it("refuses an unknown model", () => {
    const result = resolveAgentSelection({ request: { model: "Gemini 4" }, defaults: {}, catalog });
    expect(result.ok).toBe(false);
  });

  it("refuses a provider the host doesn't have", () => {
    const result = resolveAgentSelection({
      request: { provider: "copilot" },
      defaults: {},
      catalog,
    });
    expect(result.ok).toBe(false);
  });

  it("uses the user's preferred provider, model and thinking without an explicit choice", () => {
    expect(
      resolveAgentSelection({
        request: {},
        defaults: {
          provider: "codex",
          models: { codex: "gpt-6-astra" },
          thinking: { codex: "high" },
        },
        catalog,
      }),
    ).toEqual({ ok: true, provider: "codex", model: "gpt-6-astra", thinking: "high" });
  });

  it("lets an explicit model win over the defaults without borrowing their thinking", () => {
    expect(
      resolveAgentSelection({
        request: { model: "fable" },
        defaults: {
          provider: "codex",
          models: { codex: "gpt-6-astra" },
          thinking: { codex: "high", claude: "max" },
        },
        catalog,
      }),
    ).toEqual({ ok: true, provider: "claude", model: "claude-fable-5-1", thinking: null });
  });

  it("uses the provider's default model when only the provider is named", () => {
    expect(
      resolveAgentSelection({ request: { provider: "Codex" }, defaults: {}, catalog }),
    ).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-6-sol",
      thinking: null,
    });
  });

  it("asks when a model name fits several", () => {
    const result = resolveAgentSelection({ request: { model: "opus 5" }, defaults: {}, catalog });
    expect(result).toEqual({
      ok: true,
      provider: "claude",
      model: "claude-opus-5",
      thinking: null,
    });
    const vague = resolveAgentSelection({ request: { model: "gpt 6" }, defaults: {}, catalog });
    expect(vague.ok).toBe(false);
  });
});

describe("resolveAgentSelection with a model name in provider", () => {
  it("treats a provider that isn't one as the model", () => {
    expect(
      resolveAgentSelection({
        request: { provider: "Astra", effort: "extra high" },
        defaults: {},
        catalog,
      }),
    ).toEqual({ ok: true, provider: "codex", model: "gpt-6-astra", thinking: "xhigh" });
  });
});
