import type { Logger } from "pino";

import type { PersistedConfig } from "../../../persisted-config.js";
import {
  DEFAULT_ELEVENLABS_BASE_URL,
  DEFAULT_ELEVENLABS_MODEL,
  type ReadAloudVoiceSettings,
} from "../../read-aloud/config.js";
import type { TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProvider, RequestedSpeechProviders } from "../../speech-types.js";
import type { SpeechServices } from "../openai/runtime.js";
import { ElevenLabsSTT } from "./stt.js";
import { ElevenLabsTTS } from "./tts.js";

export interface ElevenLabsVoiceTtsConfig {
  model: string;
  voiceId: string | null;
  voiceSettings: ReadAloudVoiceSettings;
}

export interface ElevenLabsSpeechProviderConfig {
  apiKey: string | null;
  baseUrl: string;
  dictationSttModel?: string;
  voiceSttModel?: string;
  voiceTts?: ElevenLabsVoiceTtsConfig;
}

function isElevenLabsRequested(provider: RequestedSpeechProvider): boolean {
  return provider.enabled !== false && provider.provider === "elevenlabs";
}

function resolveVoiceTtsConfig(persisted: PersistedConfig): ElevenLabsVoiceTtsConfig {
  const voiceMode = persisted.features?.voiceMode?.tts;
  const readAloud = persisted.features?.readAloud?.tts;
  const { speed, stability, similarityBoost, style } = readAloud ?? {};
  return {
    model: voiceMode?.model ?? readAloud?.model ?? DEFAULT_ELEVENLABS_MODEL,
    voiceId: voiceMode?.voiceId ?? readAloud?.voiceId ?? null,
    voiceSettings: Object.fromEntries(
      Object.entries({ speed, stability, similarityBoost, style }).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  };
}

export function resolveElevenLabsSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): ElevenLabsSpeechProviderConfig | undefined {
  const { env, persisted, providers } = params;
  const dictation = isElevenLabsRequested(providers.dictationStt);
  const voice = isElevenLabsRequested(providers.voiceStt);
  const tts = isElevenLabsRequested(providers.voiceTts);
  if (!dictation && !voice && !tts) {
    return undefined;
  }
  const provider = persisted.providers?.elevenlabs;
  return {
    apiKey: provider?.apiKey ?? (env.ELEVENLABS_API_KEY?.trim() || null),
    baseUrl: provider?.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL,
    ...resolveSttModels({ persisted, dictation, voice }),
    ...(tts ? { voiceTts: resolveVoiceTtsConfig(persisted) } : {}),
  };
}

function resolveSttModels(params: {
  persisted: PersistedConfig;
  dictation: boolean;
  voice: boolean;
}): Pick<ElevenLabsSpeechProviderConfig, "dictationSttModel" | "voiceSttModel"> {
  const { persisted, dictation, voice } = params;
  const dictationSttModel = dictation ? persisted.features?.dictation?.stt?.model : undefined;
  const voiceSttModel = voice ? persisted.features?.voiceMode?.stt?.model : undefined;
  return {
    ...(dictationSttModel ? { dictationSttModel } : {}),
    ...(voiceSttModel ? { voiceSttModel } : {}),
  };
}

function createElevenLabsTts(params: {
  apiKey: string;
  elevenlabsConfig: ElevenLabsSpeechProviderConfig;
  logger: Logger;
}): TextToSpeechProvider | null {
  const { apiKey, elevenlabsConfig, logger } = params;
  const voiceTts = elevenlabsConfig.voiceTts;
  if (!voiceTts?.voiceId) {
    logger.warn(
      "Invalid speech configuration: ElevenLabs text-to-speech selected but no voice is set (features.voiceMode.tts.voiceId or features.readAloud.tts.voiceId) — voice mode will be unavailable",
    );
    return null;
  }
  return new ElevenLabsTTS(
    {
      apiKey,
      baseUrl: elevenlabsConfig.baseUrl,
      voiceId: voiceTts.voiceId,
      model: voiceTts.model,
      voiceSettings: voiceTts.voiceSettings,
    },
    logger,
  );
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
  const needsTts = !existing.ttsService && isElevenLabsRequested(providers.voiceTts);
  if (!needsDictation && !needsVoice && !needsTts) {
    return existing;
  }
  const apiKey = elevenlabsConfig?.apiKey;
  if (!elevenlabsConfig || !apiKey) {
    logger.warn(
      "Invalid speech configuration: ElevenLabs speech selected but no ElevenLabs API key is set — speech features will be unavailable",
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
    ttsService: needsTts
      ? createElevenLabsTts({ apiKey, elevenlabsConfig, logger })
      : existing.ttsService,
  };
}
