import { z } from "zod";
import type pino from "pino";
import type { ServerCapabilityState } from "@getpaseo/protocol/messages";
import type { AgentManager } from "../../agent/agent-manager.js";
import { generateStructuredAgentResponseWithFallback } from "../../agent/agent-response-loop.js";
import type { ProviderSnapshotManager } from "../../agent/provider-snapshot-manager.js";
import { resolveStructuredGenerationProviders } from "../../agent/structured-generation-providers.js";
import type { ReadAloudConfig } from "./config.js";
import { synthesizeElevenLabsSpeech, type ElevenLabsSpeechResult } from "./elevenlabs.js";
import {
  buildReadAloudRewritePrompt,
  splitReadAloudSegments,
  stripMarkdownForSpeech,
} from "./script.js";

const ReadAloudScriptSchema = z.object({ script: z.string().min(1) });

export interface ReadAloudSelection {
  provider?: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
}

export interface ReadAloudServiceOptions {
  config: ReadAloudConfig;
  agentManager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  logger: pino.Logger;
  fetchImpl?: typeof fetch;
  generateStructured?: typeof generateStructuredAgentResponseWithFallback;
}

export class ReadAloudUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ReadAloudUnavailableError";
  }
}

export class ReadAloudService {
  private readonly logger: pino.Logger;

  constructor(private readonly options: ReadAloudServiceOptions) {
    this.logger = options.logger.child({ module: "read-aloud" });
  }

  getCapability(): ServerCapabilityState {
    const reason = this.options.config.unavailableReason;
    return { enabled: reason === null, reason: reason ?? "" };
  }

  async prepare(input: {
    text: string;
    cwd: string;
    currentSelection?: ReadAloudSelection;
  }): Promise<string[]> {
    this.assertAvailable();
    const script = await this.buildScript(input);
    const segments = splitReadAloudSegments(script);
    if (segments.length === 0) {
      throw new Error("Nothing to read aloud");
    }
    return segments;
  }

  async synthesize(input: {
    text: string;
    previousRequestIds?: readonly string[];
  }): Promise<ElevenLabsSpeechResult> {
    this.assertAvailable();
    const { elevenlabs, tts } = this.options.config;
    if (!elevenlabs || !tts.voiceId) {
      throw new ReadAloudUnavailableError("Read aloud is not configured on this host.");
    }
    return synthesizeElevenLabsSpeech({
      apiKey: elevenlabs.apiKey,
      baseUrl: elevenlabs.baseUrl,
      voiceId: tts.voiceId,
      model: tts.model,
      text: input.text,
      voiceSettings: tts.voiceSettings,
      previousRequestIds: input.previousRequestIds,
      fetchImpl: this.options.fetchImpl,
    });
  }

  private assertAvailable(): void {
    const reason = this.options.config.unavailableReason;
    if (reason !== null) {
      throw new ReadAloudUnavailableError(reason);
    }
  }

  private async buildScript(input: {
    text: string;
    cwd: string;
    currentSelection?: ReadAloudSelection;
  }): Promise<string> {
    const plain = stripMarkdownForSpeech(input.text);
    if (!this.options.config.rewrite.enabled) {
      return plain;
    }
    try {
      const providers = await resolveStructuredGenerationProviders({
        cwd: input.cwd,
        providerSnapshotManager: this.options.providerSnapshotManager,
        daemonConfig: { metadataGeneration: { providers: this.options.config.rewrite.providers } },
        currentSelection: input.currentSelection,
      });
      const generate =
        this.options.generateStructured ?? generateStructuredAgentResponseWithFallback;
      const result = await generate({
        manager: this.options.agentManager,
        cwd: input.cwd,
        prompt: buildReadAloudRewritePrompt(input.text),
        schema: ReadAloudScriptSchema,
        schemaName: "ReadAloudScript",
        maxRetries: 1,
        providers,
        persistSession: false,
        logger: this.logger,
        agentConfigOverrides: { title: "Read aloud script", internal: true },
      });
      return result.script;
    } catch (error) {
      // Reading the reply as written beats failing the play button when no agent can rewrite.
      this.logger.warn({ err: error }, "Read aloud rewrite failed; reading the reply as written");
      return plain;
    }
  }
}
