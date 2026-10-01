import pino from "pino";
import { describe, expect, it } from "vitest";
import type { AgentManager } from "../../agent/agent-manager.js";
import { resolveReadAloudConfig } from "./config.js";
import { ReadAloudService, type ReadAloudServiceOptions } from "./service.js";

const configured = resolveReadAloudConfig({
  env: {},
  persisted: {
    providers: { elevenlabs: { apiKey: "key" } },
    features: { readAloud: { tts: { voiceId: "voice-1" } } },
  },
});

function createService(overrides: Partial<ReadAloudServiceOptions> = {}): ReadAloudService {
  return new ReadAloudService({
    config: configured,
    agentManager: {} as AgentManager,
    providerSnapshotManager: { listProviders: async () => [] },
    logger: pino({ level: "silent" }),
    ...overrides,
  });
}

describe("ReadAloudService", () => {
  it("reads the rewritten script when an agent can rewrite the reply", async () => {
    const prompts: string[] = [];
    const service = createService({
      generateStructured: async <T>(input: { prompt: string }) => {
        prompts.push(input.prompt);
        return { script: "Listo, terminé el cambio." } as T;
      },
    });

    const segments = await service.prepare({ text: "**Done**: see `a.ts`", cwd: "/tmp" });

    expect(segments).toEqual(["Listo, terminé el cambio."]);
    expect(prompts[0]).toContain("<reply>\n**Done**: see `a.ts`\n</reply>");
  });

  it("reads the reply without markdown when no agent can rewrite it", async () => {
    const service = createService({
      generateStructured: async () => {
        throw new Error("no providers");
      },
    });

    const segments = await service.prepare({ text: "## Hecho\n\nTodo **listo**.", cwd: "/tmp" });

    expect(segments).toEqual(["Hecho. Todo listo."]);
  });

  it("refuses to prepare or synthesize until the host is configured", async () => {
    const service = createService({
      config: resolveReadAloudConfig({ env: {}, persisted: {} }),
    });

    expect(service.getCapability()).toEqual({
      enabled: false,
      reason: "Add an ElevenLabs API key on this host to read replies aloud.",
    });
    await expect(service.prepare({ text: "Hola", cwd: "/tmp" })).rejects.toThrow(
      "Add an ElevenLabs API key on this host to read replies aloud.",
    );
    await expect(service.synthesize({ text: "Hola" })).rejects.toThrow(
      "Add an ElevenLabs API key on this host to read replies aloud.",
    );
  });
});
