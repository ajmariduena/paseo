import type pino from "pino";
import {
  FastLlmClient,
  FastLlmError,
  type FastLlmCompletion,
  type FastLlmConfig,
  type FastLlmRequest,
} from "./llm-client.js";

export interface FastLlm {
  readonly available: boolean;
  complete(params: FastLlmRequest): Promise<FastLlmCompletion>;
}

export interface RoundTrip {
  provider: string;
  model: string;
  ms: number;
}

/** With a backup waiting, a stalled model is abandoned sooner. */
const PRIMARY_TIMEOUT_WITH_BACKUP_MS = 4_000;
/** Requests still running on a replaced model keep their sockets this long. */
const RETIRE_AFTER_MS = 30_000;

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

/**
 * The call's fast model and its backup. Settings replace them while the daemon runs; the
 * backup answers when the model fails, stalls, or has no key.
 */
export class FastBrain implements FastLlm {
  private primary: FastLlmClient | null = null;
  private backup: FastLlmClient | null = null;
  private warm = false;
  private lastRoundTrip: RoundTrip | null = null;

  constructor(private readonly logger: pino.Logger) {}

  get available(): boolean {
    return this.primary !== null || this.backup !== null;
  }

  get roundTrip(): RoundTrip | null {
    return this.lastRoundTrip;
  }

  configure(params: { primary: FastLlmConfig | null; backup: FastLlmConfig | null }): void {
    const retired = [this.primary, this.backup];
    this.primary = params.primary ? new FastLlmClient(params.primary, this.logger) : null;
    this.backup = params.backup ? new FastLlmClient(params.backup, this.logger) : null;
    if (this.warm) this.keepWarm(true);
    const timer = setTimeout(() => {
      for (const client of retired) client?.dispose();
    }, RETIRE_AFTER_MS);
    timer.unref?.();
    if (params.primary || params.backup) {
      this.logger.info(
        {
          model: params.primary && `${params.primary.provider}/${params.primary.model}`,
          backup: params.backup && `${params.backup.provider}/${params.backup.model}`,
        },
        "Voice fast brain ready",
      );
    }
  }

  async complete(params: FastLlmRequest): Promise<FastLlmCompletion> {
    const first = this.primary ?? this.backup;
    if (!first) throw new FastLlmError("No fast model is set up for calls", null);
    const second = first === this.primary ? this.backup : null;
    try {
      const timeoutMs = second
        ? Math.min(
            params.timeoutMs ?? PRIMARY_TIMEOUT_WITH_BACKUP_MS,
            PRIMARY_TIMEOUT_WITH_BACKUP_MS,
          )
        : params.timeoutMs;
      return this.note(first, await first.complete({ ...params, timeoutMs }));
    } catch (error) {
      if (!second || isAbort(error, params.signal)) throw error;
      this.logger.warn(
        { err: error, model: first.config.model, backup: second.config.model },
        "Fast model failed; the backup answers",
      );
      return this.note(second, await second.complete(params));
    }
  }

  /** One request straight to the model or the backup, for the settings' Test button. */
  async test(
    target: "selection" | "backup",
    params: FastLlmRequest,
  ): Promise<{ completion: FastLlmCompletion; config: FastLlmConfig }> {
    const client = target === "selection" ? this.primary : this.backup;
    if (!client) {
      throw new FastLlmError(
        target === "selection" ? "The model has no API key" : "No backup is set",
        null,
      );
    }
    await client.warm();
    const completion = this.note(client, await client.complete(params));
    return { completion, config: client.config };
  }

  keepWarm(active: boolean): void {
    this.warm = active;
    this.primary?.keepWarm(active);
    this.backup?.keepWarm(active);
  }

  private note(client: FastLlmClient, completion: FastLlmCompletion): FastLlmCompletion {
    this.lastRoundTrip = {
      provider: client.config.provider,
      model: client.config.model,
      ms: completion.elapsedMs,
    };
    return completion;
  }
}
