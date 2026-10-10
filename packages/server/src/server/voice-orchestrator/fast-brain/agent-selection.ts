import { normalizeName } from "../fleet/fleet-view.js";

export interface SelectableModel {
  provider: string;
  id: string;
  label: string;
  aliases?: string[];
  isDefault?: boolean;
  thinkingOptions?: Array<{ id: string; label: string }>;
  defaultThinkingOptionId?: string;
}

export interface AgentSelectionRequest {
  provider?: string;
  model?: string;
  effort?: string;
}

export interface AgentSelectionDefaults {
  provider?: string;
  models?: Record<string, string>;
  thinking?: Record<string, string>;
}

export type AgentSelection =
  | { ok: true; provider: string; model: string; thinking: string | null }
  | { ok: false; reason: string };

/** What people say for an effort level, mapped to the option ids providers use. */
const EFFORT_SYNONYMS: Array<{ ids: string[]; spoken: string[] }> = [
  {
    ids: ["xhigh", "extra-high", "extra_high"],
    spoken: ["extra high", "xhigh", "x high", "extra alto", "muy alto", "extra"],
  },
  { ids: ["ultracode", "ultra-code", "ultra"], spoken: ["ultra code", "ultracode", "ultra"] },
  { ids: ["max", "maximum"], spoken: ["max", "maximo", "maximum", "al maximo"] },
  { ids: ["high"], spoken: ["high", "alto", "alta"] },
  { ids: ["medium"], spoken: ["medium", "medio", "media"] },
  { ids: ["low"], spoken: ["low", "bajo", "baja"] },
  { ids: ["minimal"], spoken: ["minimal", "minimo", "minima"] },
  { ids: ["none", "off"], spoken: ["none", "sin razonamiento", "off", "ninguno"] },
];

/**
 * Turns what the user said ("Astra en extra high", "Opus 5.5 ultra code") into a provider,
 * model and thinking option that exist on the host that will run the agent. An explicit
 * choice that doesn't exist is an error to tell the user, never a silent fallback.
 */
export function resolveAgentSelection(params: {
  request: AgentSelectionRequest;
  defaults: AgentSelectionDefaults;
  /** Models per provider on the target host; only available providers are listed. */
  catalog: Record<string, SelectableModel[]>;
}): AgentSelection {
  const { defaults, catalog } = params;
  const providers = Object.keys(catalog);
  const request = normalizeRequest(params.request, providers);
  const requestedProvider = request.provider
    ? matchProvider(request.provider, providers)
    : undefined;
  if (request.provider && !requestedProvider) {
    return {
      ok: false,
      reason: `There is no provider "${request.provider}" on that host. Available: ${providers.join(", ")}.`,
    };
  }
  const picked = request.model
    ? pickNamedModel(request.model, requestedProvider, catalog)
    : pickDefaultModel(requestedProvider, defaults, catalog);
  if (!picked.ok) return picked;
  const { model } = picked;
  if (request.effort) {
    const option = matchEffort(request.effort, model.thinkingOptions ?? []);
    if (!option) return { ok: false, reason: describeMissingEffort(model, request.effort) };
    return { ok: true, provider: model.provider, model: model.id, thinking: option.id };
  }
  const preferredThinking =
    !request.model || defaults.models?.[model.provider] === model.id
      ? defaults.thinking?.[model.provider]
      : undefined;
  const thinking =
    preferredThinking && model.thinkingOptions?.some((entry) => entry.id === preferredThinking)
      ? preferredThinking
      : null;
  return { ok: true, provider: model.provider, model: model.id, thinking };
}

/** "con Astra" often lands in provider; a provider name that isn't one is a model name. */
function normalizeRequest(
  request: AgentSelectionRequest,
  providers: string[],
): AgentSelectionRequest {
  if (request.provider && !request.model && !matchProvider(request.provider, providers)) {
    return { ...request, model: request.provider, provider: undefined };
  }
  return request;
}

type PickedModel = { ok: true; model: SelectableModel } | { ok: false; reason: string };

function pickNamedModel(
  spoken: string,
  provider: string | undefined,
  catalog: Record<string, SelectableModel[]>,
): PickedModel {
  const pool = provider
    ? (catalog[provider] ?? [])
    : Object.values(catalog).flatMap((models) => models);
  const matches = matchModels(spoken, pool);
  const [only] = matches;
  if (matches.length === 1 && only) return { ok: true, model: only };
  if (matches.length === 0) {
    const where = provider ? ` for ${provider}` : "";
    const some = pool
      .slice(0, 8)
      .map((entry) => entry.label)
      .join(", ");
    return {
      ok: false,
      reason: `There is no model "${spoken}"${where} on that host. Some available: ${some}.`,
    };
  }
  const options = matches
    .slice(0, 4)
    .map((entry) => `${entry.label} (${entry.provider})`)
    .join(" or ");
  return { ok: false, reason: `"${spoken}" could be ${options}; ask which one.` };
}

function pickDefaultModel(
  requestedProvider: string | undefined,
  defaults: AgentSelectionDefaults,
  catalog: Record<string, SelectableModel[]>,
): PickedModel {
  const preferredProvider =
    defaults.provider && catalog[defaults.provider] ? defaults.provider : undefined;
  const fallbackProvider = catalog.claude ? "claude" : Object.keys(catalog)[0];
  const provider = requestedProvider ?? preferredProvider ?? fallbackProvider;
  if (!provider) return { ok: false, reason: "No agent provider is available on that host." };
  const models = catalog[provider] ?? [];
  const preferred = defaults.models?.[provider];
  const model =
    (preferred ? models.find((entry) => entry.id === preferred) : undefined) ??
    models.find((entry) => entry.isDefault) ??
    models[0];
  if (!model) return { ok: false, reason: `${provider} has no models on that host.` };
  return { ok: true, model };
}

function describeMissingEffort(model: SelectableModel, effort: string): string {
  const options = model.thinkingOptions ?? [];
  if (options.length === 0) return `${model.label} has no effort levels to choose.`;
  return `${model.label} has no "${effort}" effort. Its options: ${options.map((entry) => entry.label).join(", ")}.`;
}

function matchProvider(spoken: string, providers: string[]): string | undefined {
  const wanted = normalizeName(spoken).replace(/\s+/g, "");
  return (
    providers.find((provider) => normalizeName(provider).replace(/\s+/g, "") === wanted) ??
    providers.find((provider) => normalizeName(provider).replace(/\s+/g, "").includes(wanted))
  );
}

function matchModels(spoken: string, pool: SelectableModel[]): SelectableModel[] {
  const wanted = normalizeName(spoken.replace(/(\d)[.,](\d)/g, "$1 $2"));
  const tokens = wanted.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const names = (entry: SelectableModel) =>
    [entry.id, entry.label, ...(entry.aliases ?? [])].map((name) =>
      normalizeName(name.replace(/(\d)[.,](\d)/g, "$1 $2")),
    );
  const exact = pool.filter((entry) => names(entry).some((name) => name === wanted));
  if (exact.length > 0) return exact;
  const containing = pool.filter((entry) =>
    names(entry).some((name) => {
      const words = name.split(" ");
      return tokens.every((token) => words.includes(token));
    }),
  );
  if (containing.length <= 1) return containing;
  // "astra" matches gpt-6-astra and gpt-6-astra-mini: the base model is the one meant.
  const base = containing.find((entry) =>
    containing.every((other) => other === entry || other.id.startsWith(entry.id)),
  );
  return base ? [base] : containing;
}

function matchEffort(
  spoken: string,
  options: Array<{ id: string; label: string }>,
): { id: string; label: string } | undefined {
  const wanted = normalizeName(spoken);
  const direct = options.find(
    (option) => normalizeName(option.id) === wanted || normalizeName(option.label) === wanted,
  );
  if (direct) return direct;
  const synonym = EFFORT_SYNONYMS.find((entry) =>
    entry.spoken.some((phrase) => wanted === phrase || wanted.includes(phrase)),
  );
  if (!synonym) return undefined;
  return options.find((option) =>
    synonym.ids.some(
      (id) =>
        normalizeName(option.id) === normalizeName(id) ||
        normalizeName(option.label) === normalizeName(id),
    ),
  );
}
