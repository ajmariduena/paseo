import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DictationSttOption, ServerDictationStt } from "@getpaseo/protocol/messages";

import type { PersistedConfig } from "../persisted-config.js";
import type { PaseoOpenAIConfig, PaseoSpeechConfig } from "../bootstrap.js";
import { DEFAULT_ELEVENLABS_STT_MODEL } from "./providers/elevenlabs/stt.js";
import { resolveLocalModelsDir } from "./providers/local/config.js";
import { getLocalSpeechModelDir, listLocalSpeechModels } from "./providers/local/models.js";
import { getOpenAiSpeechAvailability } from "./providers/openai/runtime.js";

const DEFAULT_OPENAI_DICTATION_MODEL = "whisper-1";
const OPENAI_DICTATION_OPTION_MODEL = "gpt-4o-transcribe";

const LOCAL_STT_LABELS: Record<string, string> = {
  "parakeet-tdt-0.6b-v2-int8": "Parakeet v2",
  "parakeet-tdt-0.6b-v3-int8": "Parakeet v3",
};

const MODEL_LABELS: Record<string, string> = {
  ...LOCAL_STT_LABELS,
  scribe_v1: "Scribe v1",
  scribe_v2: "Scribe v2",
  "whisper-1": "Whisper",
  "gpt-4o-transcribe": "GPT-4o Transcribe",
  "gpt-4o-mini-transcribe": "GPT-4o mini Transcribe",
};

export function getDictationModelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

function isLocalModelDownloaded(modelsDir: string, modelId: string): boolean {
  const spec = listLocalSpeechModels().find((entry) => entry.id === modelId);
  if (!spec) return false;
  const modelDir = getLocalSpeechModelDir(modelsDir, spec.id);
  return spec.requiredFiles.every((file) => existsSync(join(modelDir, file)));
}

function resolveActiveModel(params: {
  speech: PaseoSpeechConfig | undefined;
  openai: PaseoOpenAIConfig | undefined;
}): { provider: string; model: string } {
  const provider = params.speech?.providers.dictationStt.provider ?? "local";
  if (provider === "elevenlabs") {
    return {
      provider,
      model: params.speech?.elevenlabs?.dictationSttModel ?? DEFAULT_ELEVENLABS_STT_MODEL,
    };
  }
  if (provider === "openai") {
    return { provider, model: params.openai?.stt?.model ?? DEFAULT_OPENAI_DICTATION_MODEL };
  }
  return { provider, model: params.speech?.local?.models.dictationStt ?? "" };
}

export function describeDictationStt(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  speech: PaseoSpeechConfig | undefined;
  openai: PaseoOpenAIConfig | undefined;
}): ServerDictationStt {
  const { env, persisted } = params;
  const modelsDir = resolveLocalModelsDir(params);
  const localOptions: DictationSttOption[] = listLocalSpeechModels()
    .filter((spec) => spec.kind === "stt-offline")
    .map((spec) => ({
      provider: "local",
      model: spec.id,
      label: LOCAL_STT_LABELS[spec.id] ?? spec.id,
      description: spec.description,
      available: true,
      downloaded: isLocalModelDownloaded(modelsDir, spec.id),
    }));

  const elevenLabsKey =
    persisted.providers?.elevenlabs?.apiKey ?? env.ELEVENLABS_API_KEY?.trim() ?? "";
  const elevenLabsOption: DictationSttOption = {
    provider: "elevenlabs",
    model: DEFAULT_ELEVENLABS_STT_MODEL,
    label: `ElevenLabs ${getDictationModelLabel(DEFAULT_ELEVENLABS_STT_MODEL)}`,
    description: "Cloud transcription with strong accuracy in many languages.",
    available: elevenLabsKey.length > 0,
    ...(elevenLabsKey.length > 0
      ? {}
      : { unavailableReason: "Add an ElevenLabs API key to this host." }),
  };

  const openAiAvailable = getOpenAiSpeechAvailability(params.openai).dictationStt;
  const openAiOption: DictationSttOption = {
    provider: "openai",
    model: OPENAI_DICTATION_OPTION_MODEL,
    label: `OpenAI ${getDictationModelLabel(OPENAI_DICTATION_OPTION_MODEL)}`,
    description: "Cloud transcription from OpenAI.",
    available: openAiAvailable,
    ...(openAiAvailable ? {} : { unavailableReason: "Add an OpenAI API key to this host." }),
  };

  const active = resolveActiveModel(params);
  return {
    ...active,
    language: params.speech?.sttLanguages?.dictation ?? "en",
    locked: env.PASEO_DICTATION_STT_PROVIDER !== undefined,
    options: [...localOptions, elevenLabsOption, openAiOption],
  };
}
