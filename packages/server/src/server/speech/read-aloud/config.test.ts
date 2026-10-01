import { describe, expect, it } from "vitest";
import { resolveReadAloudConfig } from "./config.js";

describe("resolveReadAloudConfig", () => {
  it("is available once an API key and a voice are configured", () => {
    const config = resolveReadAloudConfig({
      env: {},
      persisted: {
        providers: { elevenlabs: { apiKey: "key" } },
        features: { readAloud: { tts: { voiceId: "voice-1", speed: 1.1 } } },
      },
    });

    expect(config).toEqual({
      unavailableReason: null,
      elevenlabs: { apiKey: "key", baseUrl: "https://api.elevenlabs.io" },
      tts: { model: "eleven_flash_v2_5", voiceId: "voice-1", voiceSettings: { speed: 1.1 } },
      rewrite: { enabled: true },
    });
  });

  it("falls back to ELEVENLABS_API_KEY and the metadata generation providers", () => {
    const config = resolveReadAloudConfig({
      env: { ELEVENLABS_API_KEY: "env-key" },
      persisted: {
        agents: { metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] } },
        features: { readAloud: { tts: { voiceId: "voice-1" } } },
      },
    });

    expect(config.elevenlabs?.apiKey).toBe("env-key");
    expect(config.rewrite).toEqual({
      enabled: true,
      providers: [{ provider: "claude", model: "haiku" }],
    });
  });

  it("explains what is missing before the host can read aloud", () => {
    expect(resolveReadAloudConfig({ env: {}, persisted: {} }).unavailableReason).toBe(
      "Add an ElevenLabs API key on this host to read replies aloud.",
    );
    expect(
      resolveReadAloudConfig({
        env: {},
        persisted: { providers: { elevenlabs: { apiKey: "key" } } },
      }).unavailableReason,
    ).toBe("Choose an ElevenLabs voice on this host to read replies aloud.");
    expect(
      resolveReadAloudConfig({
        env: {},
        persisted: {
          providers: { elevenlabs: { apiKey: "key" } },
          features: { readAloud: { enabled: false, tts: { voiceId: "voice-1" } } },
        },
      }).unavailableReason,
    ).toBe("Read aloud is turned off on this host.");
  });
});
