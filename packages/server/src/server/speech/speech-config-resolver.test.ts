import path from "node:path";

import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "../persisted-config.js";
import { describeDictationStt } from "./dictation-selection.js";
import { resolveSpeechConfig } from "./speech-config-resolver.js";

describe("resolveSpeechConfig", () => {
  test("resolves local-first defaults without env overrides", () => {
    const paseoHome = "/tmp/paseo-home";
    const persisted = PersistedConfigSchema.parse({});
    const env = {} as NodeJS.ProcessEnv;

    const result = resolveSpeechConfig({
      paseoHome,
      env,
      persisted,
    });

    expect(result.openai).toBeUndefined();
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.local).toEqual({
      modelsDir: path.join(paseoHome, "models", "local-speech"),
      models: {
        dictationStt: "parakeet-tdt-0.6b-v2-int8",
        voiceStt: "parakeet-tdt-0.6b-v2-int8",
        voiceTts: "kokoro-en-v0_19",
        voiceTtsSpeakerId: 0,
      },
    });
    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceTts).toBe("kokoro-en-v0_19");
    expect(result.speech.local?.models.voiceTtsSpeakerId).toBe(0);
    expect(result.speech.sttLanguages).toEqual({
      dictation: "en",
      voice: "en",
    });
  });

  test("resolves feature-scoped local speech settings", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        voiceMode: {
          turnDetection: { provider: "local" },
          stt: { provider: "openai", model: "gpt-4o-transcribe" },
        },
      },
      providers: {
        openai: { apiKey: "persisted-key" },
      },
    });
    const env = {
      PASEO_DICTATION_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
      PASEO_VOICE_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
      PASEO_VOICE_LOCAL_TTS_MODEL: "kokoro-en-v0_19",
      PASEO_VOICE_LOCAL_TTS_SPEAKER_ID: "5",
      PASEO_VOICE_LOCAL_TTS_SPEED: "1.35",
      PASEO_DICTATION_LANGUAGE: "es",
      PASEO_VOICE_LANGUAGE: "pt",
      PASEO_LOCAL_MODELS_DIR: "/tmp/models",
      OPENAI_API_KEY: "env-key",
      PASEO_VOICE_STT_PROVIDER: "openai",
      PASEO_DICTATION_STT_PROVIDER: "local",
      PASEO_VOICE_TTS_PROVIDER: "local",
    } as NodeJS.ProcessEnv;

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env,
      persisted,
    });

    expect(result.speech.local).toEqual({
      modelsDir: "/tmp/models",
      models: {
        dictationStt: "parakeet-tdt-0.6b-v2-int8",
        voiceStt: "parakeet-tdt-0.6b-v2-int8",
        voiceTts: "kokoro-en-v0_19",
        voiceTtsSpeakerId: 5,
        voiceTtsSpeed: 1.35,
      },
    });
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "openai",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceTts).toBe("kokoro-en-v0_19");
    expect(result.speech.local?.models.voiceTtsSpeakerId).toBe(5);
    expect(result.speech.local?.models.voiceTtsSpeed).toBe(1.35);
    expect(result.speech.sttLanguages).toEqual({
      dictation: "es",
      voice: "pt",
    });
    expect(result.openai?.stt?.apiKey).toBe("persisted-key");
    expect(result.openai?.tts?.apiKey).toBe("persisted-key");
    expect(result.openai?.stt?.model).toBe("gpt-4o-transcribe");
  });

  test("resolves STT language from env, settings, and voice-to-dictation fallback", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: {
          stt: {
            language: "fr",
          },
        },
        voiceMode: {
          stt: {
            language: "de",
          },
        },
      },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: {
        PASEO_DICTATION_LANGUAGE: "es",
        PASEO_VOICE_LANGUAGE: "  ",
      } as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.sttLanguages).toEqual({
      dictation: "es",
      voice: "es",
    });
  });

  test("respects disabled dictation and voice mode feature flags", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: { enabled: false },
        voiceMode: { enabled: false },
      },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: {} as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
  });

  test("routes dictation to ElevenLabs Scribe with the shared ElevenLabs key", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: { elevenlabs: { apiKey: "xi-test" } },
      features: {
        dictation: { stt: { provider: "elevenlabs", model: "scribe_v2", language: "es" } },
      },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: {} as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.providers.dictationStt).toEqual({
      provider: "elevenlabs",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.elevenlabs).toEqual({
      apiKey: "xi-test",
      baseUrl: "https://api.elevenlabs.io",
      dictationSttModel: "scribe_v2",
    });
    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.sttLanguages?.dictation).toBe("es");
  });

  test("routes voice TTS to ElevenLabs with the read-aloud voice as fallback", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: { elevenlabs: { apiKey: "xi-test" } },
      features: {
        voiceMode: { tts: { provider: "elevenlabs" } },
        readAloud: {
          tts: { model: "eleven_v3", voiceId: "read-aloud-voice", speed: 1.1, stability: 0.4 },
        },
      },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: {} as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.providers.voiceTts).toEqual({
      provider: "elevenlabs",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.elevenlabs).toEqual({
      apiKey: "xi-test",
      baseUrl: "https://api.elevenlabs.io",
      voiceTts: {
        model: "eleven_v3",
        voiceId: "read-aloud-voice",
        voiceSettings: { speed: 1.1, stability: 0.4 },
      },
    });
  });

  test("prefers voice-mode ElevenLabs voice and model over read-aloud", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        voiceMode: {
          tts: { provider: "elevenlabs", model: "eleven_flash_v2_5", voiceId: "voice-mode-voice" },
        },
        readAloud: { tts: { model: "eleven_v3", voiceId: "read-aloud-voice" } },
      },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: { ELEVENLABS_API_KEY: " xi-env " } as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.elevenlabs).toEqual({
      apiKey: "xi-env",
      baseUrl: "https://api.elevenlabs.io",
      voiceTts: { model: "eleven_flash_v2_5", voiceId: "voice-mode-voice", voiceSettings: {} },
    });
  });

  test("defaults the ElevenLabs voice TTS model and leaves the voice unresolved", () => {
    const persisted = PersistedConfigSchema.parse({
      features: { voiceMode: { tts: { provider: "elevenlabs" } } },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: {} as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.elevenlabs?.voiceTts).toEqual({
      model: "eleven_flash_v2_5",
      voiceId: null,
      voiceSettings: {},
    });
  });
});

describe("describeDictationStt", () => {
  function describeFor(raw: unknown, env: NodeJS.ProcessEnv = {}) {
    const paseoHome = "/tmp/paseo-home-missing";
    const persisted = PersistedConfigSchema.parse(raw);
    const { openai, speech } = resolveSpeechConfig({ paseoHome, env, persisted });
    return describeDictationStt({ paseoHome, env, persisted, speech, openai });
  }

  test("reports the default local model and offers cloud models that lack keys as unavailable", () => {
    const result = describeFor({});

    expect(result).toMatchObject({
      provider: "local",
      model: "parakeet-tdt-0.6b-v2-int8",
      language: "en",
      locked: false,
    });
    expect(
      result.options.map((option) => [option.provider, option.model, option.available]),
    ).toEqual([
      ["local", "parakeet-tdt-0.6b-v2-int8", true],
      ["local", "parakeet-tdt-0.6b-v3-int8", true],
      ["elevenlabs", "scribe_v2_realtime", false],
      ["elevenlabs", "scribe_v2", false],
      ["openai", "gpt-4o-transcribe", false],
    ]);
    expect(result.options[0]?.downloaded).toBe(false);
  });

  test("defaults ElevenLabs dictation to the realtime model and reports its language", () => {
    const result = describeFor({
      providers: { elevenlabs: { apiKey: "key" } },
      features: { dictation: { stt: { provider: "elevenlabs", language: "es" } } },
    });

    expect(result).toMatchObject({
      provider: "elevenlabs",
      model: "scribe_v2_realtime",
      language: "es",
    });
    expect(
      result.options
        .filter((option) => option.provider === "elevenlabs")
        .map((option) => option.available),
    ).toEqual([true, true]);
  });

  test("keeps a persisted batch ElevenLabs model", () => {
    const result = describeFor({
      providers: { elevenlabs: { apiKey: "key" } },
      features: { dictation: { stt: { provider: "elevenlabs", model: "scribe_v2" } } },
    });

    expect(result).toMatchObject({ provider: "elevenlabs", model: "scribe_v2" });
  });

  test("locks the selection when a launch override picks the provider", () => {
    expect(describeFor({}, { PASEO_DICTATION_STT_PROVIDER: "local" }).locked).toBe(true);
  });
});
