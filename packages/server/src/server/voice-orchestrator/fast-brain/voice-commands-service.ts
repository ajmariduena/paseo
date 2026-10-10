import type pino from "pino";
import type {
  VoiceCommandsModel,
  VoiceCommandsSettings,
} from "@getpaseo/protocol/voice-commands/rpc-schemas";
import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "../../persisted-config.js";
import {
  findBrainProvider,
  resolveVoiceBrain,
  voiceCommandsSettings,
  type BrainProviderId,
  type VoiceBrainResolution,
} from "./brain-catalog.js";
import type { FastBrain } from "./fast-brain.js";
import { ROUTER_SYSTEM_PROMPT, ROUTER_TOOLS, buildRouterRequest } from "./router-prompt.js";

type Router = NonNullable<
  NonNullable<NonNullable<PersistedConfig["features"]>["voiceMode"]>["router"]
>;
type KeyedProvider = Exclude<BrainProviderId, "custom">;

const TEST_TIMEOUT_MS = 10_000;

export interface VoiceCommandsTestResult {
  ok: boolean;
  roundTripMs: number | null;
  model: VoiceCommandsModel | null;
  error: string | null;
  settings: VoiceCommandsSettings;
}

type Providers = NonNullable<PersistedConfig["providers"]>;

function withApiKey(providers: Providers, id: KeyedProvider, apiKey: string | null): Providers {
  const { apiKey: _previous, ...rest } = providers[id] ?? {};
  const next = apiKey ? { ...rest, apiKey } : rest;
  return { ...providers, [id]: Object.keys(next).length > 0 ? next : undefined };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BrainChoice {
  provider: BrainProviderId;
  model: string;
}

function validModel(choice: VoiceCommandsModel): BrainChoice {
  const provider = findBrainProvider(choice.provider);
  if (!provider) throw new Error(`Unknown provider: ${choice.provider}`);
  const model = choice.model.trim();
  if (!model) throw new Error("Choose a model");
  if (provider.id !== "custom" && !provider.models.some((entry) => entry.id === model)) {
    throw new Error(`${provider.label} has no model ${model}`);
  }
  return { provider: provider.id, model };
}

/**
 * The host side of Settings → Voice → Voice commands: which fast model answers on calls, its
 * keys and its measured latency. Changes apply to the next request without a restart.
 */
export class VoiceCommandsService {
  constructor(
    private readonly options: {
      paseoHome: string;
      env: NodeJS.ProcessEnv;
      brain: FastBrain;
      logger: pino.Logger;
    },
  ) {}

  settings(): VoiceCommandsSettings {
    return voiceCommandsSettings(this.resolve(), this.options.brain.roundTrip);
  }

  setModel(params: {
    selection?: VoiceCommandsModel | null;
    backup?: VoiceCommandsModel | null;
    customBaseUrl?: string;
  }): VoiceCommandsSettings {
    const selection = params.selection ? validModel(params.selection) : params.selection;
    const backup = params.backup ? validModel(params.backup) : params.backup;
    this.updateRouter((router) => {
      const next: Router = { ...router };
      if (params.customBaseUrl !== undefined) {
        const baseUrl = params.customBaseUrl.trim();
        if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new Error("Enter an http or https URL");
        next.custom = { ...router.custom, baseUrl };
      }
      if (selection === null) {
        next.provider = "off";
        delete next.model;
        delete next.reasoningEffort;
      } else if (selection) {
        next.provider = selection.provider;
        next.model = selection.model;
        delete next.reasoningEffort;
      }
      if (backup === null) next.backup = false;
      else if (backup) {
        next.backup = { provider: backup.provider, model: backup.model };
      }
      const usesCustom =
        next.provider === "custom" || (next.backup && next.backup.provider === "custom");
      if (usesCustom && !next.custom?.baseUrl) throw new Error("Set the endpoint URL first");
      return next;
    });
    return this.settings();
  }

  setKey(params: { provider: string; apiKey: string | null }): VoiceCommandsSettings {
    const provider = findBrainProvider(params.provider);
    if (!provider) throw new Error(`Unknown provider: ${params.provider}`);
    const apiKey = params.apiKey?.trim() || null;
    const id = provider.id;
    if (id === "custom") {
      this.updateRouter((router) => {
        if (!router.custom?.baseUrl) throw new Error("Set the endpoint URL first");
        const custom = { ...router.custom };
        if (apiKey) custom.apiKey = apiKey;
        else delete custom.apiKey;
        return { ...router, custom };
      });
      return this.settings();
    }
    this.update((persisted) => ({
      ...persisted,
      providers: withApiKey(persisted.providers ?? {}, id, apiKey),
    }));
    return this.settings();
  }

  async test(target: "selection" | "backup"): Promise<VoiceCommandsTestResult> {
    const resolution = this.resolve();
    const model = target === "selection" ? resolution.selection : resolution.backup;
    try {
      const { completion } = await this.options.brain.test(target, {
        messages: [
          { role: "system", content: ROUTER_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildRouterRequest({
              fleet: "One host, this computer, with no agents running.",
              conversation: [],
              latest: "What's running right now?",
              language: "en",
              pendingConfirmation: null,
            }),
          },
        ],
        tools: ROUTER_TOOLS,
        toolChoice: "required",
        maxTokens: 200,
        timeoutMs: TEST_TIMEOUT_MS,
      });
      if (completion.toolCalls.length === 0) {
        return this.testResult(
          false,
          completion.elapsedMs,
          model,
          "The model answered without using a tool",
        );
      }
      return this.testResult(true, completion.elapsedMs, model, null);
    } catch (error) {
      this.options.logger.info({ err: error, target }, "Voice commands test failed");
      return this.testResult(false, null, model, errorMessage(error));
    }
  }

  private testResult(
    ok: boolean,
    roundTripMs: number | null,
    model: VoiceCommandsModel | null,
    error: string | null,
  ): VoiceCommandsTestResult {
    return { ok, roundTripMs, model, error, settings: this.settings() };
  }

  private resolve(): VoiceBrainResolution {
    return resolveVoiceBrain({
      env: this.options.env,
      persisted: loadPersistedConfig(this.options.paseoHome, this.options.logger),
    });
  }

  private updateRouter(change: (router: Router) => Router): void {
    this.update((persisted) => {
      const features = persisted.features ?? {};
      const voiceMode = features.voiceMode ?? {};
      return {
        ...persisted,
        features: {
          ...features,
          voiceMode: { ...voiceMode, router: change(voiceMode.router ?? {}) },
        },
      };
    });
  }

  private update(change: (persisted: PersistedConfig) => PersistedConfig): void {
    const persisted = loadPersistedConfig(this.options.paseoHome, this.options.logger);
    savePersistedConfig(this.options.paseoHome, change(persisted), this.options.logger);
    const resolution = this.resolve();
    this.options.brain.configure({ primary: resolution.primary, backup: resolution.fallback });
  }
}
