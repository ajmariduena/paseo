import type { PersistedConfig } from "../../persisted-config.js";

export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const DEFAULT_ELEVENLABS_MODEL = "eleven_flash_v2_5";

export interface ReadAloudVoiceSettings {
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  style?: number;
}

export interface ReadAloudStructuredProvider {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
}

export interface ReadAloudConfig {
  unavailableReason: string | null;
  elevenlabs: { apiKey: string; baseUrl: string } | null;
  tts: {
    model: string;
    voiceId: string | null;
    voiceSettings: ReadAloudVoiceSettings;
  };
  rewrite: {
    enabled: boolean;
    providers?: ReadAloudStructuredProvider[];
  };
}

type ReadAloudFeatureConfig = NonNullable<NonNullable<PersistedConfig["features"]>["readAloud"]>;

export function resolveReadAloudConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): ReadAloudConfig {
  const feature = params.persisted.features?.readAloud;
  const elevenlabs = resolveElevenLabsCredentials(params);
  const tts = resolveTts(feature);
  return {
    unavailableReason: resolveUnavailableReason({
      enabled: feature?.enabled,
      hasApiKey: elevenlabs !== null,
      hasVoice: tts.voiceId !== null,
    }),
    elevenlabs,
    tts,
    rewrite: resolveRewrite(feature, params.persisted),
  };
}

function resolveElevenLabsCredentials(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): ReadAloudConfig["elevenlabs"] {
  const provider = params.persisted.providers?.elevenlabs;
  const apiKey = provider?.apiKey ?? params.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, baseUrl: provider?.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL };
}

function resolveTts(feature: ReadAloudFeatureConfig | undefined): ReadAloudConfig["tts"] {
  const { model, voiceId, speed, stability, similarityBoost, style } = feature?.tts ?? {};
  return {
    model: model ?? DEFAULT_ELEVENLABS_MODEL,
    voiceId: voiceId ?? null,
    voiceSettings: omitUndefined({ speed, stability, similarityBoost, style }),
  };
}

function resolveRewrite(
  feature: ReadAloudFeatureConfig | undefined,
  persisted: PersistedConfig,
): ReadAloudConfig["rewrite"] {
  const providers = feature?.rewrite?.providers ?? persisted.agents?.metadataGeneration?.providers;
  return {
    enabled: feature?.rewrite?.enabled ?? true,
    ...(providers ? { providers } : {}),
  };
}

function resolveUnavailableReason(input: {
  enabled: boolean | undefined;
  hasApiKey: boolean;
  hasVoice: boolean;
}): string | null {
  if (input.enabled === false) return "Read aloud is turned off on this host.";
  if (!input.hasApiKey) return "Add an ElevenLabs API key on this host to read replies aloud.";
  if (!input.hasVoice) return "Choose an ElevenLabs voice on this host to read replies aloud.";
  return null;
}

function omitUndefined(settings: ReadAloudVoiceSettings): ReadAloudVoiceSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as ReadAloudVoiceSettings;
}
