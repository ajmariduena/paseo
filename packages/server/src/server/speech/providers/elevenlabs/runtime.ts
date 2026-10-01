import type { Logger } from "pino";

import type { PersistedConfig } from "../../../persisted-config.js";
import { DEFAULT_ELEVENLABS_BASE_URL } from "../../read-aloud/config.js";
import type { RequestedSpeechProvider, RequestedSpeechProviders } from "../../speech-types.js";
import type { SpeechServices } from "../openai/runtime.js";
import { ElevenLabsSTT } from "./stt.js";

export interface ElevenLabsSpeechProviderConfig {
  apiKey: string | null;
  baseUrl: string;
  dictationSttModel?: string;
  voiceSttModel?: string;
}

function isElevenLabsRequested(provider: RequestedSpeechProvider): boolean {
  return provider.enabled !== false && provider.provider === "elevenlabs";
}

export function resolveElevenLabsSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): ElevenLabsSpeechProviderConfig | undefined {
  const { env, persisted, providers } = params;
  const dictation = isElevenLabsRequested(providers.dictationStt);
  const voice = isElevenLabsRequested(providers.voiceStt);
  if (!dictation && !voice) {
    return undefined;
  }
  const provider = persisted.providers?.elevenlabs;
  const dictationSttModel = dictation ? persisted.features?.dictation?.stt?.model : undefined;
  const voiceSttModel = voice ? persisted.features?.voiceMode?.stt?.model : undefined;
  return {
    apiKey: provider?.apiKey ?? (env.ELEVENLABS_API_KEY?.trim() || null),
    baseUrl: provider?.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL,
    ...(dictationSttModel ? { dictationSttModel } : {}),
    ...(voiceSttModel ? { voiceSttModel } : {}),
  };
}

export function initializeElevenLabsSpeechServices(params: {
  providers: RequestedSpeechProviders;
  elevenlabsConfig: ElevenLabsSpeechProviderConfig | undefined;
  existing: SpeechServices;
  logger: Logger;
}): SpeechServices {
  const { providers, elevenlabsConfig, existing, logger } = params;
  const needsDictation =
    !existing.dictationSttService && isElevenLabsRequested(providers.dictationStt);
  const needsVoice = !existing.sttService && isElevenLabsRequested(providers.voiceStt);
  if (!needsDictation && !needsVoice) {
    return existing;
  }
  const apiKey = elevenlabsConfig?.apiKey;
  if (!elevenlabsConfig || !apiKey) {
    logger.warn(
      "Invalid speech configuration: ElevenLabs speech-to-text selected but no ElevenLabs API key is set — speech features will be unavailable",
    );
    return existing;
  }
  const create = (model: string | undefined) =>
    new ElevenLabsSTT({ apiKey, baseUrl: elevenlabsConfig.baseUrl, model }, logger);
  return {
    ...existing,
    dictationSttService: needsDictation
      ? create(elevenlabsConfig.dictationSttModel)
      : existing.dictationSttService,
    sttService: needsVoice ? create(elevenlabsConfig.voiceSttModel) : existing.sttService,
  };
}
