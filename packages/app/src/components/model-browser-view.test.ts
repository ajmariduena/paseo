import { describe, expect, it } from "vitest";
import type {
  ProviderSelectionModelRow,
  ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import {
  groupProfilesByProviderModel,
  resolveFavoriteRows,
  resolveInitialModelBrowserView,
  resolveLockedRailProviders,
  resolveModelBrowserScrolling,
  resolveModelBrowserSearch,
  resolveModelShortcutIndex,
  resolveSelectableProviders,
  resolveVisibleModelRows,
} from "./model-browser-view";

function provider(
  id: string,
  label: string,
  rows: ProviderSelectionModelRow[] = [],
): ProviderSelectorProvider {
  return {
    id,
    label,
    modelSelection: { kind: "models", rows },
  };
}

function modelRow(
  providerId: string,
  providerLabel: string,
  modelId: string,
  modelLabel: string,
): ProviderSelectionModelRow {
  return {
    favoriteKey: `${providerId}:${modelId}`,
    provider: providerId,
    providerLabel,
    modelId,
    modelLabel,
    description: modelId,
  };
}

describe("model browser scrolling", () => {
  it("participates in native compact bottom-sheet scrolling", () => {
    expect(resolveModelBrowserScrolling({ isNative: true, isCompact: true })).toBe("sheet");
  });

  it.each([
    { platform: "native wide", isNative: true, isCompact: false },
    { platform: "compact web", isNative: false, isCompact: true },
    { platform: "wide web", isNative: false, isCompact: false },
  ])("owns scrolling on $platform surfaces", ({ isNative, isCompact }) => {
    expect(resolveModelBrowserScrolling({ isNative, isCompact })).toBe("independent");
  });
});

describe("model browser initial view", () => {
  const codex = provider("codex", "Codex");
  const pi = provider("pi", "Pi");

  it("opens Favorites once something pickable is starred", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "pi",
        favoriteCount: 1,
        hasProfiles: true,
      }),
    ).toEqual({ kind: "favorites" });
  });

  it("opens the provider in use when nothing is starred", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "pi",
        favoriteCount: 0,
        hasProfiles: true,
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("falls back to the first provider when the selected one is gone", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "gemini",
        favoriteCount: 0,
        hasProfiles: false,
      }),
    ).toEqual({ kind: "provider", providerId: "codex", providerLabel: "Codex" });
  });

  it("opens Profiles when the host lists no providers but has profiles", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [],
        selectedProvider: "",
        favoriteCount: 0,
        hasProfiles: true,
      }),
    ).toEqual({ kind: "profiles" });
  });
});

describe("groupProfilesByProviderModel", () => {
  it("groups profiles by provider and model, skipping profiles without a model", () => {
    const lookup = groupProfilesByProviderModel([
      { provider: "claude", modelId: "opus-5" },
      { provider: "claude", modelId: "opus-5" },
      { provider: "claude", modelId: "sonnet-4.6" },
      { provider: "claude", modelId: "" },
      { provider: "codex", modelId: "gpt-5.4" },
    ]);

    expect(lookup.get("claude:opus-5")).toHaveLength(2);
    expect(lookup.get("claude:sonnet-4.6")).toHaveLength(1);
    expect(lookup.get("codex:gpt-5.4")).toHaveLength(1);
    expect(lookup.has("claude:")).toBe(false);
  });

  it("trims model ids so whitespace cannot create a separate key", () => {
    const lookup = groupProfilesByProviderModel([
      { provider: "claude", modelId: "opus-5" },
      { provider: "claude", modelId: "  opus-5  " },
    ]);

    expect(lookup.get("claude:opus-5")).toHaveLength(2);
  });

  it("returns an empty map for no refs", () => {
    expect(groupProfilesByProviderModel([]).size).toBe(0);
  });
});

describe("model browser tabs and search", () => {
  const claude = provider("claude", "Claude Code", [
    modelRow("claude", "Claude Code", "opus-5", "Opus 5"),
    modelRow("claude", "Claude Code", "sonnet-4.6", "Sonnet 4.6"),
  ]);
  const copilot = provider("copilot", "Copilot", [
    modelRow("copilot", "Copilot", "claude-opus-5", "Opus 5"),
  ]);
  const codex = provider("codex", "Codex", [modelRow("codex", "Codex", "gpt-5.4", "GPT-5.4")]);
  const providers = [claude, copilot, codex];

  it("stays on the tab while the query is empty", () => {
    expect(resolveModelBrowserSearch({ providers, normalizedQuery: "" })).toEqual({
      kind: "idle",
    });
  });

  it("ranks the same model label across every provider that offers it", () => {
    const search = resolveModelBrowserSearch({ providers, normalizedQuery: "opus" });
    expect(search.kind === "results" ? search.rows.map((row) => row.favoriteKey) : []).toEqual([
      "claude:opus-5",
      "copilot:claude-opus-5",
    ]);
  });

  it("matches models by their provider label", () => {
    const search = resolveModelBrowserSearch({ providers, normalizedQuery: "codex" });
    expect(search.kind === "results" ? search.rows.map((row) => row.modelId) : []).toEqual([
      "gpt-5.4",
    ]);
  });

  it("reports no matches instead of falling back to the tab", () => {
    expect(resolveModelBrowserSearch({ providers, normalizedQuery: "zzzz" })).toEqual({
      kind: "noMatches",
    });
  });

  it("keeps a started chat's search inside its provider", () => {
    const selectable = resolveSelectableProviders(providers, "copilot");
    expect(selectable.map((entry) => entry.id)).toEqual(["copilot"]);
    const search = resolveModelBrowserSearch({ providers: selectable, normalizedQuery: "opus" });
    expect(search.kind === "results" ? search.rows.map((row) => row.favoriteKey) : []).toEqual([
      "copilot:claude-opus-5",
    ]);
    expect(resolveSelectableProviders(providers, null)).toBe(providers);
  });

  it("lists favorites in catalog order and skips stars the host no longer lists", () => {
    const rows = resolveFavoriteRows({
      providers,
      favoriteKeys: ["codex:gpt-5.4", "claude:gone", "claude:opus-5"],
    });
    expect(rows.map((row) => row.favoriteKey)).toEqual(["claude:opus-5", "codex:gpt-5.4"]);
  });
});

describe("model shortcuts", () => {
  const key = (
    value: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>>,
  ) => ({
    key: value,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("reads Cmd+digit on mac and Ctrl+digit elsewhere", () => {
    expect(resolveModelShortcutIndex(key("1", { metaKey: true }), true)).toBe(0);
    expect(resolveModelShortcutIndex(key("9", { ctrlKey: true }), false)).toBe(8);
    expect(resolveModelShortcutIndex(key("1", { ctrlKey: true }), true)).toBeNull();
    expect(resolveModelShortcutIndex(key("1", { metaKey: true }), false)).toBeNull();
  });

  it("ignores zero, letters and extra modifiers", () => {
    expect(resolveModelShortcutIndex(key("0", { metaKey: true }), true)).toBeNull();
    expect(resolveModelShortcutIndex(key("m", { metaKey: true }), true)).toBeNull();
    expect(resolveModelShortcutIndex(key("2", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(resolveModelShortcutIndex(key("2", {}), true)).toBeNull();
  });

  it("indexes the rows on screen: search results first, then the open tab", () => {
    const claude = provider("claude", "Claude", [
      modelRow("claude", "Claude", "opus", "Opus"),
      modelRow("claude", "Claude", "sonnet", "Sonnet"),
    ]);
    const favoriteRows = [modelRow("claude", "Claude", "sonnet", "Sonnet")];
    const base = { selectableProviders: [claude], favoriteRows };
    expect(
      resolveVisibleModelRows({
        ...base,
        view: { kind: "provider", providerId: "claude", providerLabel: "Claude" },
        search: { kind: "idle" },
      }).map((row) => row.modelId),
    ).toEqual(["opus", "sonnet"]);
    expect(
      resolveVisibleModelRows({ ...base, view: { kind: "favorites" }, search: { kind: "idle" } }),
    ).toBe(favoriteRows);
    expect(
      resolveVisibleModelRows({
        ...base,
        view: { kind: "favorites" },
        search: {
          kind: "results",
          rows: [
            claude.modelSelection.kind === "models"
              ? claude.modelSelection.rows[0]
              : favoriteRows[0],
          ],
        },
      }).map((row) => row.modelId),
    ).toEqual(["opus"]);
    expect(
      resolveVisibleModelRows({ ...base, view: { kind: "profiles" }, search: { kind: "idle" } }),
    ).toEqual([]);
  });
});

describe("resolveLockedRailProviders", () => {
  it("keeps host order and puts the chat's own provider in its slot", () => {
    const own = provider("codex", "Codex live");
    const rail = resolveLockedRailProviders({
      own: [own],
      all: [provider("claude", "Claude"), provider("codex", "Codex"), provider("pi", "Pi")],
    });
    expect(rail.map((entry) => entry.label)).toEqual(["Claude", "Codex live", "Pi"]);
  });

  it("keeps the chat's provider even when the host no longer lists it", () => {
    const rail = resolveLockedRailProviders({
      own: [provider("gone", "Gone")],
      all: [provider("claude", "Claude")],
    });
    expect(rail.map((entry) => entry.id)).toEqual(["gone", "claude"]);
  });
});
