import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent, request } from "node:https";
import type pino from "pino";

export interface FastLlmConfig {
  /** Display name for logs: cerebras, openai, … */
  provider: string;
  /** OpenAI-compatible base URL ending in /v1. */
  baseUrl: string;
  /** Empty for endpoints that need no key, like a model on the local network. */
  apiKey: string;
  model: string;
  /** `none` turns reasoning off on models that support it. */
  reasoningEffort: string | null;
}

export interface FastLlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type FastLlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: FastLlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface FastLlmTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface FastLlmRequest {
  messages: FastLlmMessage[];
  tools?: FastLlmTool[];
  toolChoice?: "auto" | "none" | "required";
  maxTokens: number;
  temperature?: number;
  jsonObject?: boolean;
  cacheKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  hedgeAfterMs?: number;
}

export interface FastLlmCompletion {
  content: string | null;
  toolCalls: FastLlmToolCall[];
  /** Wall time of the HTTP exchange, as the call experiences it. */
  elapsedMs: number;
  usage: { promptTokens: number; cachedTokens: number; completionTokens: number } | null;
}

export class FastLlmError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "FastLlmError";
  }
}

const DEFAULT_TIMEOUT_MS = 8_000;
// Kept warm during a call; a cold TLS handshake costs more than the model itself.
const KEEP_WARM_INTERVAL_MS = 20_000;

interface CompletionResponseBody {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: FastLlmToolCall[] };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

function isFinalStatus(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 429;
}

function parseCompletion(
  response: { status: number; body: string },
  elapsedMs: number,
): FastLlmCompletion {
  let parsed: CompletionResponseBody;
  try {
    parsed = JSON.parse(response.body) as CompletionResponseBody;
  } catch {
    throw new FastLlmError(`Unreadable reply (${response.status})`, response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new FastLlmError(
      parsed.error?.message ?? `Request failed (${response.status})`,
      response.status,
    );
  }
  const message = parsed.choices?.[0]?.message;
  const usage = parsed.usage;
  return {
    content: message?.content ?? null,
    toolCalls: message?.tool_calls ?? [],
    elapsedMs,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens ?? 0,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
        }
      : null,
  };
}

/**
 * A minimal OpenAI-compatible chat client tuned for latency: one keep-alive socket pool per
 * host, warmed at call start and kept warm while a call runs.
 */
export class FastLlmClient {
  private readonly agent: Agent | HttpAgent;
  private readonly send: typeof request;
  private readonly url: URL;
  private warmTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly config: FastLlmConfig,
    private readonly logger: pino.Logger,
  ) {
    this.url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`);
    const options = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8 };
    const secure = this.url.protocol === "https:";
    this.agent = secure ? new Agent(options) : new HttpAgent(options);
    this.send = secure ? request : httpRequest;
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {};
  }

  /**
   * One completion. With `hedgeAfterMs`, a request still waiting after that long gets an
   * identical twin and the first answer wins: shared inference queues have a long tail, and
   * a second request is usually served by a less busy replica.
   */
  async complete(params: FastLlmRequest): Promise<FastLlmCompletion> {
    if (!params.hedgeAfterMs) return this.completeOnce(params);
    const controllers = [new AbortController(), new AbortController()];
    const abortAll = () => {
      for (const controller of controllers) controller.abort();
    };
    params.signal?.addEventListener("abort", abortAll, { once: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = (index: number) =>
      this.completeOnce({ ...params, signal: controllers[index].signal }).then((result) => {
        controllers[1 - index].abort();
        return result;
      });
    const first = attempt(0).catch((error: unknown) => {
      // A request the server rejected (4xx other than 429) fails the same way twice.
      if (error instanceof FastLlmError && isFinalStatus(error.status)) {
        if (timer) clearTimeout(timer);
        abortAll();
      }
      throw error;
    });
    const hedge = new Promise<FastLlmCompletion>((resolve, reject) => {
      timer = setTimeout(() => attempt(1).then(resolve, reject), params.hedgeAfterMs);
      first.catch((error: unknown) => {
        if (error instanceof FastLlmError && isFinalStatus(error.status)) reject(error);
      });
      params.signal?.addEventListener(
        "abort",
        () => {
          if (timer) clearTimeout(timer);
          reject(new DOMException("The request was aborted", "AbortError"));
        },
        { once: true },
      );
    });
    try {
      return await Promise.any([first, hedge]);
    } catch (error) {
      throw error instanceof AggregateError ? (error.errors[0] as Error) : error;
    } finally {
      if (timer) clearTimeout(timer);
      params.signal?.removeEventListener("abort", abortAll);
    }
  }

  private async completeOnce(params: FastLlmRequest): Promise<FastLlmCompletion> {
    const startedAt = performance.now();
    const response = await this.post(
      JSON.stringify(this.buildBody(params)),
      params.signal,
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return parseCompletion(response, Math.round(performance.now() - startedAt));
  }

  private buildBody(params: FastLlmRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: params.messages,
      max_completion_tokens: params.maxTokens,
      temperature: params.temperature ?? 0.2,
    };
    if (this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;
    if (params.tools?.length) {
      body.tools = params.tools;
      body.tool_choice = params.toolChoice ?? "auto";
      body.parallel_tool_calls = true;
    }
    if (params.jsonObject) body.response_format = { type: "json_object" };
    if (params.cacheKey && this.config.provider === "cerebras") {
      body.prompt_cache_key = params.cacheKey;
    }
    return body;
  }

  /** Opens the TLS connection ahead of the first request and keeps it open during a call. */
  keepWarm(active: boolean): void {
    if (!active) {
      if (this.warmTimer) clearInterval(this.warmTimer);
      this.warmTimer = null;
      return;
    }
    void this.warm();
    if (this.warmTimer) return;
    this.warmTimer = setInterval(() => void this.warm(), KEEP_WARM_INTERVAL_MS);
    this.warmTimer.unref?.();
  }

  async warm(): Promise<void> {
    try {
      await this.get(`${this.config.baseUrl.replace(/\/+$/, "")}/models`);
    } catch (error) {
      this.logger.debug({ err: error }, "Fast LLM warm-up failed");
    }
  }

  dispose(): void {
    this.keepWarm(false);
    this.agent.destroy();
  }

  private post(
    payload: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = this.send(
        this.url,
        {
          method: "POST",
          agent: this.agent,
          headers: {
            ...this.authHeaders(),
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new FastLlmError(`Timed out after ${timeoutMs} ms`, null));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  private get(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.send(
        url,
        {
          method: "GET",
          agent: this.agent,
          headers: this.authHeaders(),
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
          res.on("error", reject);
        },
      );
      req.setTimeout(5_000, () => req.destroy(new Error("warm-up timed out")));
      req.on("error", reject);
      req.end();
    });
  }
}
