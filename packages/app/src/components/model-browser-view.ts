import {
  filterAndRankModelRows,
  getAllProviderModelRows,
  getProviderModelRows,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";

/** The rail's tabs: starred models, one provider's catalog, or the agent profiles. */
export type ModelBrowserView =
  | { kind: "favorites" }
  | { kind: "provider"; providerId: string; providerLabel: string }
  | { kind: "profiles" };

export function resolveModelBrowserScrolling({
  isNative,
  isCompact,
}: {
  isNative: boolean;
  isCompact: boolean;
}): "sheet" | "independent" {
  return isNative && isCompact ? "sheet" : "independent";
}

/** A profile's model reference; used to match profiles back to model rows. */
export interface ModelProfileRef {
  provider: string;
  modelId: string;
}

/**
 * Groups profiles by `provider:modelId`, skipping profiles that name no model.
 * Pure so the model browser can test it apart from the component tree.
 */
export function groupProfilesByProviderModel<T extends ModelProfileRef>(
  refs: readonly T[],
): Map<string, T[]> {
  const lookup = new Map<string, T[]>();
  for (const ref of refs) {
    const modelId = ref.modelId.trim();
    if (!modelId) {
      continue;
    }
    const key = `${ref.provider}:${modelId}`;
    const existing = lookup.get(key);
    if (existing) {
      existing.push(ref);
    } else {
      lookup.set(key, [ref]);
    }
  }
  return lookup;
}

/** A started chat can only switch models within its own provider; the rest stay visible. */
export function resolveSelectableProviders(
  providers: ProviderSelectorProvider[],
  lockedProvider: string | null,
): ProviderSelectorProvider[] {
  if (lockedProvider === null) return providers;
  return providers.filter((provider) => provider.id === lockedProvider);
}

/** Starred rows in catalog order. Stars on models a host no longer lists are skipped. */
export function resolveFavoriteRows({
  providers,
  favoriteKeys,
}: {
  providers: ProviderSelectorProvider[];
  favoriteKeys: readonly string[];
}): ProviderSelectionModelRow[] {
  if (favoriteKeys.length === 0) return [];
  const starred = new Set(favoriteKeys);
  return getAllProviderModelRows(providers).filter((row) => starred.has(row.favoriteKey));
}

export type ModelBrowserSearch =
  | { kind: "idle" }
  | { kind: "results"; rows: ProviderSelectionModelRow[] }
  | { kind: "noMatches" };

/** Typing searches every provider the chat can use; the rail steps aside while it does. */
export function resolveModelBrowserSearch({
  providers,
  normalizedQuery,
}: {
  providers: ProviderSelectorProvider[];
  normalizedQuery: string;
}): ModelBrowserSearch {
  if (!normalizedQuery) return { kind: "idle" };
  const rows = filterAndRankModelRows(getAllProviderModelRows(providers), normalizedQuery);
  return rows.length === 0 ? { kind: "noMatches" } : { kind: "results", rows };
}

/**
 * Where the picker lands: Favorites once the user has starred something it can pick, otherwise
 * the provider in use, otherwise the first one.
 */
export function resolveInitialModelBrowserView({
  providers,
  selectedProvider,
  favoriteCount,
  hasProfiles,
}: {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  favoriteCount: number;
  hasProfiles: boolean;
}): ModelBrowserView {
  if (favoriteCount > 0) return { kind: "favorites" };
  const provider = providers.find((entry) => entry.id === selectedProvider) ?? providers[0];
  if (provider) {
    return { kind: "provider", providerId: provider.id, providerLabel: provider.label };
  }
  return hasProfiles ? { kind: "profiles" } : { kind: "favorites" };
}

/**
 * ⌘1–⌘9 (Ctrl on other platforms) pick a row of the open picker. Returns the 0-based row, or
 * null for any other key.
 */
export function resolveModelShortcutIndex(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  isMac: boolean,
): number | null {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.shiftKey || event.altKey) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  return Number(event.key) - 1;
}

/** The rows on screen: search results while typing, otherwise the open tab's list. */
export function resolveVisibleModelRows(input: {
  view: ModelBrowserView;
  search: ModelBrowserSearch;
  selectableProviders: ProviderSelectorProvider[];
  favoriteRows: ProviderSelectionModelRow[];
}): ProviderSelectionModelRow[] {
  if (input.search.kind === "results") return input.search.rows;
  if (input.search.kind === "noMatches") return [];
  const view = input.view;
  switch (view.kind) {
    case "favorites":
      return input.favoriteRows;
    case "provider": {
      const provider = input.selectableProviders.find((entry) => entry.id === view.providerId);
      return provider ? getProviderModelRows(provider) : [];
    }
    case "profiles":
      return [];
    default:
      throw new Error("unreachable");
  }
}

/**
 * A started chat's rail: every provider on the host, in host order, with the chat's own provider
 * (which carries its live catalog) in its slot.
 */
export function resolveLockedRailProviders({
  own,
  all,
}: {
  own: ProviderSelectorProvider[];
  all: ProviderSelectorProvider[];
}): ProviderSelectorProvider[] {
  const ownById = new Map(own.map((provider) => [provider.id, provider]));
  const merged = all.map((provider) => ownById.get(provider.id) ?? provider);
  const missing = own.filter((provider) => !all.some((entry) => entry.id === provider.id));
  return [...missing, ...merged];
}
