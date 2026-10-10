import type {
  VoiceCommandsModel,
  VoiceCommandsSettings,
} from "@getpaseo/protocol/voice-commands/rpc-schemas";
import type { PersistedConfig } from "../../persisted-config.js";
import type { FastLlmConfig } from "./llm-client.js";

export type BrainProviderId = "cerebras" | "groq" | "sambanova" | "openai" | "google" | "custom";

interface BrainModelSpec {
  id: string;
  label: string;
  description?: string;
  /** `none` turns reasoning off; gpt-oss and Gemini 3 only go down to `low` and `minimal`. */
  reasoningEffort: string | null;
}

interface BrainProviderSpec {
  id: BrainProviderId;
  label: string;
  baseUrl: string | null;
  envKey: string | null;
  models: BrainModelSpec[];
}

export const BRAIN_PROVIDERS: readonly BrainProviderSpec[] = [
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    models: [
      {
        id: "qwen-3.8-27b",
        label: "Qwen 3.8 27B",
        description: "Fastest, about 0.3 s",
        reasoningEffort: "none",
      },
      { id: "gpt-oss-120b", label: "GPT-OSS 120B", reasoningEffort: "low" },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    models: [
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", reasoningEffort: "low" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", reasoningEffort: "low" },
    ],
  },
  {
    id: "sambanova",
    label: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    envKey: "SAMBANOVA_API_KEY",
    models: [
      { id: "gpt-oss-120b", label: "GPT-OSS 120B", reasoningEffort: "low" },
      { id: "Meta-Llama-3.3-70B-Instruct", label: "Llama 3.3 70B", reasoningEffort: null },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    models: [
      {
        id: "gpt-6-luna",
        label: "GPT-6 Luna",
        description: "Uses the call's OpenAI key, 1–3 s",
        reasoningEffort: "none",
      },
    ],
  },
  {
    id: "google",
    label: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    models: [
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", reasoningEffort: "minimal" },
    ],
  },
  { id: "custom", label: "Custom endpoint", baseUrl: null, envKey: null, models: [] },
];

/** Picked in this order when the user has not chosen; the first one with a key wins. */
const AUTOMATIC_ORDER: readonly BrainProviderId[] = ["cerebras", "groq", "openai"];
const DEFAULT_BACKUP: VoiceCommandsModel = { provider: "openai", model: "gpt-6-luna" };

type RouterConfig = NonNullable<
  NonNullable<NonNullable<PersistedConfig["features"]>["voiceMode"]>["router"]
>;

export interface VoiceBrainResolution {
  selection: VoiceCommandsModel | null;
  backup: VoiceCommandsModel | null;
  primary: FastLlmConfig | null;
  fallback: FastLlmConfig | null;
  providers: VoiceCommandsSettings["providers"];
}

export function findBrainProvider(id: string): BrainProviderSpec | undefined {
  return BRAIN_PROVIDERS.find((provider) => provider.id === id);
}

function providerEndpoint(
  provider: BrainProviderSpec,
  params: { env: NodeJS.ProcessEnv; persisted: PersistedConfig },
): { apiKey: string | undefined; baseUrl: string | undefined } {
  if (provider.id === "custom") {
    const custom = params.persisted.features?.voiceMode?.router?.custom;
    return { apiKey: custom?.apiKey, baseUrl: custom?.baseUrl };
  }
  const configured = params.persisted.providers?.[provider.id];
  const envKey = provider.envKey ? params.env[provider.envKey]?.trim() : undefined;
  return {
    apiKey: configured?.apiKey ?? (envKey || undefined),
    baseUrl: configured?.baseUrl ?? provider.baseUrl ?? undefined,
  };
}

function isUsable(provider: BrainProviderSpec, endpoint: { apiKey?: string; baseUrl?: string }) {
  // A custom endpoint on the local network may need no key.
  return provider.id === "custom" ? Boolean(endpoint.baseUrl) : Boolean(endpoint.apiKey);
}

function toLlmConfig(
  choice: VoiceCommandsModel | null,
  params: { env: NodeJS.ProcessEnv; persisted: PersistedConfig; reasoningOverride?: string },
): FastLlmConfig | null {
  if (!choice) return null;
  const provider = findBrainProvider(choice.provider);
  if (!provider) return null;
  const endpoint = providerEndpoint(provider, params);
  if (!isUsable(provider, endpoint) || !endpoint.baseUrl) return null;
  const spec = provider.models.find((model) => model.id === choice.model);
  return {
    provider: provider.id,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey ?? "",
    model: choice.model,
    reasoningEffort: params.reasoningOverride ?? spec?.reasoningEffort ?? null,
  };
}

function resolveSelection(
  router: RouterConfig | undefined,
  hasKey: (id: BrainProviderId) => boolean,
): VoiceCommandsModel | null {
  if (router?.provider === "off") return null;
  const id: BrainProviderId =
    router?.provider ?? AUTOMATIC_ORDER.find((candidate) => hasKey(candidate)) ?? "cerebras";
  const provider = findBrainProvider(id);
  const model = router?.model ?? provider?.models[0]?.id;
  return model ? { provider: id, model } : null;
}

function resolveBackup(
  router: RouterConfig | undefined,
  selection: VoiceCommandsModel | null,
): VoiceCommandsModel | null {
  if (router?.backup === false) return null;
  if (router?.backup) return { provider: router.backup.provider, model: router.backup.model };
  if (selection?.provider === DEFAULT_BACKUP.provider) return null;
  return DEFAULT_BACKUP;
}

/** What the call's fast model is, what backs it up, and which providers have keys. */
export function resolveVoiceBrain(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): VoiceBrainResolution {
  const router = params.persisted.features?.voiceMode?.router;
  const providers = BRAIN_PROVIDERS.map((provider) => {
    const endpoint = providerEndpoint(provider, params);
    return {
      id: provider.id,
      label: provider.label,
      hasKey: provider.id === "custom" ? Boolean(endpoint.apiKey) : isUsable(provider, endpoint),
      ...(provider.id === "custom" && endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
    };
  });
  const hasKey = (id: BrainProviderId) =>
    providers.find((provider) => provider.id === id)?.hasKey ?? false;
  const selection = resolveSelection(router, hasKey);
  const backup = resolveBackup(router, selection);
  return {
    selection,
    backup,
    primary: toLlmConfig(selection, { ...params, reasoningOverride: router?.reasoningEffort }),
    fallback: toLlmConfig(backup, params),
    providers,
  };
}

function activeModel(resolution: VoiceBrainResolution): VoiceCommandsModel | null {
  if (resolution.primary) return resolution.selection;
  if (resolution.fallback) return resolution.backup;
  return null;
}

export function voiceCommandsSettings(
  resolution: VoiceBrainResolution,
  lastRoundTrip: { provider: string; model: string; ms: number } | null,
): VoiceCommandsSettings {
  const active = activeModel(resolution);
  const options = BRAIN_PROVIDERS.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.id,
      model: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
    })),
  );
  const measured =
    lastRoundTrip &&
    active?.provider === lastRoundTrip.provider &&
    active.model === lastRoundTrip.model
      ? lastRoundTrip.ms
      : null;
  return {
    selection: resolution.selection,
    backup: resolution.backup,
    active,
    lastRoundTripMs: measured,
    providers: resolution.providers,
    options,
  };
}
