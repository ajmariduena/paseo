import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type pino from "pino";
import type { VoiceToolResult } from "@getpaseo/protocol/voice-fleet/types";
import { describeLanguage } from "../prompt.js";
import {
  isBareApproval,
  isSpokenApproval,
  isSpokenRefusal,
  mentionsApproval,
} from "../spoken-approval.js";
import type { FleetHost, FleetTarget, FleetView } from "../fleet/fleet-view.js";
import type {
  FastLlmClient,
  FastLlmCompletion,
  FastLlmMessage,
  FastLlmToolCall,
} from "./llm-client.js";
import { ROUTER_SYSTEM_PROMPT, ROUTER_TOOLS, buildRouterRequest } from "./router-prompt.js";

export interface RouterExecutor {
  execute(params: {
    host: FleetHost;
    tool: string;
    args: Record<string, unknown>;
    operationId: string;
  }): Promise<VoiceToolResult>;
  /** Starts long work on the full assistant; resolves with what to tell the user now. */
  escalate(request: string): Promise<string>;
}

export interface RouteInput {
  /** The user's latest words: the request being handled. */
  latest: string;
  /** Earlier conversation, oldest first, as "User: …" / "Assistant: …" lines. */
  conversation: readonly string[];
  view: FleetView;
  language: string | null;
  /**
   * `voice-model`: GPT-Live paraphrases the facts. `speech`: the text is spoken as is, so it
   * must already be natural sentences in the user's language.
   */
  audience: "voice-model" | "speech";
}

export type RouteKind = "answer" | "action" | "question" | "confirm" | "escalated" | "failed";

export interface RouteResult {
  text: string;
  kind: RouteKind;
  /** Milliseconds per stage, for the call record. */
  timings: Record<string, number>;
}

export interface RoutePlan {
  key: string;
  /** Refs in the plan point into this view, so the route that uses the plan must use it too. */
  view: FleetView;
  completion: Promise<FastLlmCompletion>;
}

interface PendingCall {
  host: FleetHost;
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

interface ExecutedCall {
  call: PendingCall;
  result: VoiceToolResult;
}

interface Challenge {
  calls: PendingCall[];
  question: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 120_000;
// Most router calls finish in 0.2–0.5 s; past this one is stuck in a queue.
const HEDGE_AFTER_MS = 650;
const MAX_ROUNDS = 3;
const ROUTER_MAX_TOKENS = 700;
const ANSWER_MAX_TOKENS = 260;
// A search already ran; searching again in the same request only loops.
const FOLLOW_UP_TOOLS = ROUTER_TOOLS.filter((tool) => tool.function.name !== "find_sessions");
// Modes that let an agent act without asking; switching to one by voice needs a yes.
const RISKY_MODE = /bypass|yolo|full.?access|danger|skip|auto/i;
const IDEMPOTENT_BY_CONTENT = new Set(["start_agent", "create_workspace", "create_note"]);
const CREATION_DEDUPE_MS = 10 * 60 * 1000;
const DESTRUCTIVE_TOOLS = new Set(["stop_agent", "archive_agent", "archive_workspace"]);
const LOOKUP_TOOLS = new Set(["read_agent", "list_notes", "find_sessions"]);

export class RouterInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterInputError";
  }
}

/**
 * The voice call's fast brain: one small, fast model call picks the tools, the host runs them,
 * and plain facts go back to the voice model. Consequential actions wait for a spoken yes,
 * which runs without any model call.
 */
export class VoiceRouter {
  private challenge: Challenge | null = null;
  private readonly cacheKey = `voice-${uuidv4()}`;

  constructor(
    private readonly options: {
      llm: FastLlmClient;
      executor: RouterExecutor;
      logger: pino.Logger;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get hasPendingConfirmation(): boolean {
    return this.activeChallenge() !== null;
  }

  /** The first model call alone, safe to start before GPT-Live delegates: it runs nothing. */
  plan(input: RouteInput, signal?: AbortSignal): RoutePlan {
    const key = planKey(input);
    // No hedge: a speculative plan is cheap to lose, and the request itself hedges if needed.
    const completion = this.options.llm.complete({
      messages: this.initialMessages(input),
      tools: ROUTER_TOOLS,
      maxTokens: ROUTER_MAX_TOKENS,
      cacheKey: this.cacheKey,
      signal,
    });
    // A plan nobody uses must not surface as an unhandled rejection.
    completion.catch(() => undefined);
    return { key, view: input.view, completion };
  }

  async route(request: RouteInput, plan?: RoutePlan | null): Promise<RouteResult> {
    const result = await this.routeFacts(request, plan);
    if (request.audience !== "speech" || result.kind === "answer" || result.kind === "question") {
      return result;
    }
    // Without a voice model to paraphrase, the facts become what the phone says.
    const phrasedAt = this.now();
    const text = await this.phraseForSpeech(result.text, request).catch(() => result.text);
    return { ...result, text, timings: { ...result.timings, phraseMs: this.now() - phrasedAt } };
  }

  private async routeFacts(request: RouteInput, plan?: RoutePlan | null): Promise<RouteResult> {
    const startedAt = this.now();
    const timings: Record<string, number> = {};
    const done = (result: Omit<RouteResult, "timings">): RouteResult => ({
      ...result,
      timings: { ...timings, totalMs: this.now() - startedAt },
    });
    const fast = await this.confirmationFastPath(request, timings);
    if (fast) return done(fast);

    const usable = plan?.key === planKey(request) ? plan : null;
    const input = { ...request, view: usable?.view ?? request.view };
    const messages = this.initialMessages(input);
    timings.planReused = Number(usable !== null);
    let llmStartedAt = this.now();
    // A plan that failed (timeout, 429) is retried fresh instead of failing the request.
    let completion = await (usable
      ? usable.completion.catch(() => this.firstCompletion(messages))
      : this.firstCompletion(messages));
    timings.llm1Ms = this.now() - llmStartedAt;

    const results: ExecutedCall[] = [];
    let lastProblems: string[] = [];
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      if (completion.toolCalls.length === 0) {
        return this.settleAnswer({ input, results, completion, timings, startedAt });
      }
      const { calls, problems } = this.resolveCalls(completion.toolCalls, input);
      lastProblems = problems.map((problem) => problem.error);
      const intercepted = await this.intercept(calls, input);
      if (intercepted) return done(intercepted);

      const execStartedAt = this.now();
      const executed = await Promise.all(
        calls.map(async (entry) => ({
          toolCall: entry.call,
          call: entry.pending,
          result: await this.run(entry.pending, input.view, request.view),
        })),
      );
      timings[`exec${round}Ms`] = this.now() - execStartedAt;
      results.push(...executed.map(({ call, result }) => ({ call, result })));

      const needsModel =
        problems.length > 0 || executed.some((entry) => LOOKUP_TOOLS.has(entry.call.tool));
      if (!needsModel || round === MAX_ROUNDS) {
        return this.finish(input, results, null, timings, startedAt, lastProblems);
      }
      appendRound(messages, completion, executed, problems);
      llmStartedAt = this.now();
      completion = await this.followUp(messages, executed, problems.length > 0);
      timings[`llm${round + 1}Ms`] = this.now() - llmStartedAt;
      // Lookups were answered; only new actions from the follow-up call count from here.
      for (let index = results.length - 1; index >= 0; index -= 1) {
        if (LOOKUP_TOOLS.has(results[index].call.tool)) results.splice(index, 1);
      }
    }
    return this.finish(input, results, null, timings, startedAt, lastProblems);
  }

  /** The model answered in words: the reply, after whatever already ran. */
  private settleAnswer(params: {
    input: RouteInput;
    results: ExecutedCall[];
    completion: FastLlmCompletion;
    timings: Record<string, number>;
    startedAt: number;
  }): Promise<RouteResult> | RouteResult {
    const { input, results, timings, startedAt } = params;
    const answer = params.completion.content?.trim() ?? "";
    if (results.length > 0) return this.finish(input, results, answer, timings, startedAt);
    return {
      text: answer || "I couldn't work out what to do; ask the user to say it again.",
      kind: answer.endsWith("?") ? "question" : "answer",
      timings: { ...timings, totalMs: this.now() - startedAt },
    };
  }

  private firstCompletion(messages: FastLlmMessage[]): Promise<FastLlmCompletion> {
    return this.options.llm.complete({
      messages,
      tools: ROUTER_TOOLS,
      maxTokens: ROUTER_MAX_TOKENS,
      cacheKey: this.cacheKey,
      hedgeAfterMs: HEDGE_AFTER_MS,
    });
  }

  private resolveCalls(
    toolCalls: FastLlmToolCall[],
    input: RouteInput,
  ): {
    calls: Array<{ call: FastLlmToolCall; pending: PendingCall }>;
    problems: Array<{ call: FastLlmToolCall; error: string }>;
  } {
    const resolved = toolCalls.map((call) => this.resolveCall(call, input));
    return {
      calls: resolved.filter(
        (entry): entry is { call: FastLlmToolCall; pending: PendingCall } => "pending" in entry,
      ),
      problems: resolved.filter(
        (entry): entry is { call: FastLlmToolCall; error: string } => "error" in entry,
      ),
    };
  }

  /** Escalation and confirmations stop the round before anything runs. */
  private async intercept(
    calls: Array<{ call: FastLlmToolCall; pending: PendingCall }>,
    input: RouteInput,
  ): Promise<Omit<RouteResult, "timings"> | null> {
    const escalation = calls.find((entry) => entry.pending.tool === "escalate");
    if (escalation) {
      const text = await this.options.executor.escalate(
        String(escalation.pending.args.request ?? input.latest),
      );
      return { text, kind: "escalated" };
    }
    const gated = calls.filter((entry) => this.needsConfirmation(entry.pending, input));
    if (gated.length === 0) return null;
    return this.askConfirmation(gated.map((entry) => entry.pending));
  }

  private followUp(
    messages: FastLlmMessage[],
    executed: Array<{ call: PendingCall }>,
    hadProblems: boolean,
  ): Promise<FastLlmCompletion> {
    const onlyReads = executed.every(
      (entry) => entry.call.tool === "read_agent" || entry.call.tool === "list_notes",
    );
    return this.options.llm.complete({
      messages,
      tools: onlyReads && !hadProblems ? undefined : FOLLOW_UP_TOOLS,
      maxTokens: onlyReads ? ANSWER_MAX_TOKENS : ROUTER_MAX_TOKENS,
      cacheKey: this.cacheKey,
      hedgeAfterMs: HEDGE_AFTER_MS,
    });
  }

  private initialMessages(input: RouteInput): FastLlmMessage[] {
    const challenge = this.activeChallenge();
    return [
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildRouterRequest({
          fleet: input.view.routerContext(),
          conversation: input.conversation,
          latest: input.latest,
          language: input.language ? describeLanguage(input.language) : null,
          pendingConfirmation: challenge?.question ?? null,
        }),
      },
    ];
  }

  private activeChallenge(): Challenge | null {
    if (this.challenge && this.challenge.expiresAt < this.now()) this.challenge = null;
    return this.challenge;
  }

  /** A yes or no to the question Paseo just asked runs (or drops) the action with no model. */
  private async confirmationFastPath(
    input: RouteInput,
    timings: Record<string, number>,
  ): Promise<Omit<RouteResult, "timings"> | null> {
    const challenge = this.activeChallenge();
    if (!challenge) return null;
    const refusal = isSpokenRefusal(input.latest);
    if (refusal && !mentionsApproval(input.latest)) {
      this.challenge = null;
      // "No, mejor archiva el otro" is a new instruction for the model, not just a no.
      if (countWords(input.latest) <= 3) {
        return { text: "Okay, cancelled; nothing was changed.", kind: "answer" };
      }
      return null;
    }
    if (!isBareApproval(input.latest)) return null;
    this.challenge = null;
    const startedAt = this.now();
    const results = await Promise.all(
      challenge.calls.map(async (call) => ({
        call,
        result: await this.run(call, input.view, input.view),
      })),
    );
    timings.exec1Ms = this.now() - startedAt;
    timings.confirmed = 1;
    return this.summarizeResults(input, results);
  }

  private needsConfirmation(call: PendingCall, input: RouteInput): boolean {
    const challenge = this.activeChallenge();
    if (
      challenge &&
      isClearApproval(input.latest) &&
      challenge.calls.some((asked) => sameAction(asked, call))
    ) {
      return false;
    }
    if (DESTRUCTIVE_TOOLS.has(call.tool)) return true;
    // An approval runs only as the answer to a question that named that request; a yes to
    // anything else, or agent text in the fleet, must not approve a command.
    if (call.tool === "answer_permission" && call.args.allow === true) return true;
    if (call.tool === "set_agent_mode" && RISKY_MODE.test(String(call.args.mode ?? "")))
      return true;
    return false;
  }

  private askConfirmation(calls: PendingCall[]): Omit<RouteResult, "timings"> {
    const question = `Confirm: ${calls.map((call) => call.label).join("; and ")}?`;
    this.challenge = { calls, question, expiresAt: this.now() + CHALLENGE_TTL_MS };
    return {
      text: `Not done yet; it needs the user's yes. Ask them, in a few words: ${calls.map((call) => call.label).join("; and ")}? Run it only after they say yes.`,
      kind: "confirm",
    };
  }

  /**
   * Paseo just told the user an agent is waiting for permission, so their next "sí" answers
   * that request in one turn.
   */
  offerPermissionApproval(params: {
    host: FleetHost;
    agentId: string;
    requestId: string;
    label: string;
  }): void {
    const call: PendingCall = {
      host: params.host,
      tool: "answer_permission",
      args: { agentId: params.agentId, allow: true, requestId: params.requestId },
      label: `approve ${params.label}`,
    };
    this.challenge = {
      calls: [call],
      question: `Confirm: ${call.label}?`,
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    };
  }

  private async run(
    call: PendingCall,
    view: FleetView,
    current: FleetView,
  ): Promise<VoiceToolResult> {
    // A plan or a confirmation can outlive the view it was made from; reachability is now.
    const host = current.hosts.find((entry) => entry.serverId === call.host.serverId);
    if (!host?.online || !call.host.online) {
      return { ok: false, text: `${call.host.label} is offline, so it can't be done now.` };
    }
    if (call.tool === "find_sessions") {
      const matches = view.findSessions(String(call.args.query ?? ""));
      return {
        ok: true,
        text:
          matches.length > 0
            ? `Matches: ${matches.map((target) => view.describeTarget(target)).join("; ")}.`
            : "Nothing matches that name among the open sessions.",
      };
    }
    if (call.host.serverId !== null && !call.host.supportsTools) {
      return {
        ok: false,
        text: `${call.host.label} runs an older Paseo that can't take actions by voice; update it.`,
      };
    }
    try {
      return await this.options.executor.execute({
        host: call.host,
        tool: call.tool,
        args: call.args,
        operationId: operationIdFor(call),
      });
    } catch (error) {
      this.options.logger.warn({ err: error, tool: call.tool }, "Voice tool execution failed");
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Couldn't confirm it on ${call.host.label}: ${message}.` };
    }
  }

  private async finish(
    input: RouteInput,
    results: Array<{ call: PendingCall; result: VoiceToolResult }>,
    answer: string | null,
    timings: Record<string, number>,
    startedAt: number,
    problems: string[] = [],
  ): Promise<RouteResult> {
    if (results.length === 0) {
      if (!answer && problems.length > 0) {
        return {
          text: `Nothing was done: ${problems[0]}. Ask the user to say it again.`,
          kind: "failed",
          timings: { ...timings, totalMs: this.now() - startedAt },
        };
      }
      return {
        text: answer || "Nothing was done.",
        kind: (answer ?? "").endsWith("?") ? "question" : "answer",
        timings: { ...timings, totalMs: this.now() - startedAt },
      };
    }
    const summary = this.summarizeResults(input, results);
    const text = answer ? `${summary.text} ${answer}` : summary.text;
    return { text, kind: summary.kind, timings: { ...timings, totalMs: this.now() - startedAt } };
  }

  private summarizeResults(
    input: RouteInput,
    results: Array<{ call: PendingCall; result: VoiceToolResult }>,
  ): Omit<RouteResult, "timings"> {
    const failed = results.some((entry) => !entry.result.ok);
    const text = results
      .map((entry) => {
        const host =
          input.view.isMultiHost && !entry.result.text.includes(entry.call.host.label)
            ? ` (${entry.call.host.label})`
            : "";
        return `${entry.result.text}${host}`;
      })
      .join(" ");
    return { text, kind: failed ? "failed" : "action" };
  }

  private async phraseForSpeech(facts: string, input: RouteInput): Promise<string> {
    const language = input.language ? describeLanguage(input.language) : "the user's language";
    const completion = await this.options.llm.complete({
      messages: [
        {
          role: "system",
          content: `Rewrite this as what a calm voice assistant says to the user on a phone call, in ${language}: one or two short natural sentences, no lists, ids, paths or URLs. Keep every fact and add nothing. If it says to ask the user something, ask them that question directly.`,
        },
        { role: "user", content: facts },
      ],
      maxTokens: ANSWER_MAX_TOKENS,
      hedgeAfterMs: HEDGE_AFTER_MS,
    });
    return completion.content?.trim() || facts;
  }

  // eslint-disable-next-line complexity
  private resolveCall(
    call: FastLlmToolCall,
    input: RouteInput,
  ): { call: FastLlmToolCall; pending: PendingCall } | { call: FastLlmToolCall; error: string } {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      return { call, error: "the arguments were not valid JSON" };
    }
    const { view } = input;
    const local = view.localHost;
    const pick = (key: string, kinds: FleetTarget["kind"][]): FleetTarget => {
      const raw = args[key];
      if (typeof raw !== "string" || !raw.trim()) throw new RouterInputError(`${key} is missing`);
      const target = view.resolve(raw);
      if (!target || !kinds.includes(target.kind)) {
        throw new RouterInputError(`${key} "${raw}" is not a known ${kinds.join(" or ")} ref`);
      }
      return target;
    };
    const optionalHost = (): FleetHost => {
      const raw = args.host;
      if (typeof raw === "string" && raw.trim()) {
        const target = view.resolve(raw);
        if (target?.kind === "host") return target.host;
        throw new RouterInputError(`host "${raw}" is not a known host ref`);
      }
      if (!local) throw new RouterInputError("no host to run it on");
      return local;
    };
    try {
      switch (call.function.name) {
        case "send_message": {
          const target = pick("agent", ["agent", "session"]);
          return {
            call,
            pending: {
              host: target.host,
              tool: "send_message",
              args: {
                agentId: agentIdOf(target),
                message: requireText(args, "message"),
                interrupt: args.interrupt === true,
              },
              label: `send a message to ${view.speakTarget(target)}`,
            },
          };
        }
        case "start_agent": {
          const task = requireText(args, "task");
          const title = typeof args.title === "string" && args.title.trim() ? args.title : task;
          const selection = {
            provider: optionalText(args, "provider"),
            model: optionalText(args, "model"),
            effort: optionalText(args, "effort"),
          };
          if (typeof args.workspace === "string" && args.workspace.trim()) {
            const target = pick("workspace", ["workspace"]);
            if (target.kind !== "workspace") throw new RouterInputError("not a workspace");
            return {
              call,
              pending: {
                host: target.host,
                tool: "start_agent",
                args: {
                  workspaceId: target.workspace.workspaceId,
                  workspaceTitle: target.workspace.title,
                  task,
                  title,
                  ...selection,
                },
                label: `start "${title}" in ${view.speakTarget(target)}`,
              },
            };
          }
          const target = pick("project", ["project"]);
          if (target.kind !== "project") throw new RouterInputError("not a project");
          return {
            call,
            pending: {
              host: target.host,
              tool: "start_agent",
              args: {
                projectId: target.project.projectId,
                rootPath: target.project.rootPath,
                newWorktree: args.new_worktree !== false,
                task,
                title,
                ...selection,
              },
              label: `start "${title}" in ${view.speakTarget(target)}`,
            },
          };
        }
        case "create_workspace": {
          const target = pick("project", ["project"]);
          if (target.kind !== "project") throw new RouterInputError("not a project");
          const title = requireText(args, "title");
          return {
            call,
            pending: {
              host: target.host,
              tool: "create_workspace",
              args: {
                projectId: target.project.projectId,
                rootPath: target.project.rootPath,
                newWorktree: args.new_worktree !== false,
                title,
              },
              label: `create the workspace "${title}" in ${view.speakTarget(target)}`,
            },
          };
        }
        case "answer_permission": {
          const target = pick("agent", ["agent"]);
          const allow = args.decision === "allow";
          const blocker = target.kind === "agent" ? target.agent.blocker : null;
          return {
            call,
            pending: {
              host: target.host,
              tool: "answer_permission",
              args: {
                agentId: agentIdOf(target),
                allow,
                requestId: target.kind === "agent" ? target.agent.permissionId : undefined,
                note: typeof args.note === "string" ? args.note : undefined,
              },
              label: `${allow ? "approve" : "deny"} the request of ${view.speakTarget(target)}${blocker ? ` (${blocker})` : ""}`,
            },
          };
        }
        case "stop_agent": {
          const target = pick("agent", ["agent"]);
          return {
            call,
            pending: {
              host: target.host,
              tool: "stop_agent",
              args: { agentId: agentIdOf(target) },
              label: `stop ${view.speakTarget(target)}`,
            },
          };
        }
        case "archive": {
          const target = pick("target", ["agent", "session", "workspace"]);
          if (target.kind === "workspace") {
            return {
              call,
              pending: {
                host: target.host,
                tool: "archive_workspace",
                args: { workspaceId: target.workspace.workspaceId },
                label: `archive ${view.speakTarget(target)}${target.workspace.kind === "worktree" ? ", which deletes its worktree" : ""}`,
              },
            };
          }
          return {
            call,
            pending: {
              host: target.host,
              tool: "archive_agent",
              args: { agentId: agentIdOf(target) },
              label: `archive ${view.speakTarget(target)}`,
            },
          };
        }
        case "read_agent": {
          const target = pick("agent", ["agent", "session"]);
          return {
            call,
            pending: {
              host: target.host,
              tool: "read_agent",
              args: { agentId: agentIdOf(target) },
              label: `read ${view.speakTarget(target)}`,
            },
          };
        }
        case "set_agent_mode": {
          const target = pick("agent", ["agent", "session"]);
          return {
            call,
            pending: {
              host: target.host,
              tool: "set_agent_mode",
              args: { agentId: agentIdOf(target), mode: requireText(args, "mode") },
              label: `change the mode of ${view.speakTarget(target)}`,
            },
          };
        }
        case "rename": {
          const target = pick("target", ["agent", "session", "workspace"]);
          const title = requireText(args, "title");
          return {
            call,
            pending:
              target.kind === "workspace"
                ? {
                    host: target.host,
                    tool: "rename_workspace",
                    args: { workspaceId: target.workspace.workspaceId, title },
                    label: `rename ${view.speakTarget(target)}`,
                  }
                : {
                    host: target.host,
                    tool: "rename_agent",
                    args: { agentId: agentIdOf(target), title },
                    label: `rename ${view.speakTarget(target)}`,
                  },
          };
        }
        case "create_note":
          return {
            call,
            pending: {
              host: optionalHost(),
              tool: "create_note",
              args: {
                title: requireText(args, "title"),
                body: typeof args.body === "string" ? args.body : undefined,
              },
              label: "save a note",
            },
          };
        case "list_notes":
          return {
            call,
            pending: { host: optionalHost(), tool: "list_notes", args: {}, label: "read notes" },
          };
        case "host_health":
          return {
            call,
            pending: { host: optionalHost(), tool: "host_health", args: {}, label: "host health" },
          };
        case "find_sessions":
          return {
            call,
            pending: {
              host: local ?? view.hosts[0],
              tool: "find_sessions",
              args: { query: requireText(args, "query") },
              label: "search sessions",
            },
          };
        case "escalate":
          return {
            call,
            pending: {
              host: local ?? view.hosts[0],
              tool: "escalate",
              args: { request: requireText(args, "request") },
              label: "hand it to the full assistant",
            },
          };
        default:
          return { call, error: `there is no tool named ${call.function.name}` };
      }
    } catch (error) {
      return { call, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function appendRound(
  messages: FastLlmMessage[],
  completion: FastLlmCompletion,
  executed: Array<{ toolCall: FastLlmToolCall; result: VoiceToolResult }>,
  problems: Array<{ call: FastLlmToolCall; error: string }>,
): void {
  messages.push({
    role: "assistant",
    content: completion.content,
    tool_calls: completion.toolCalls,
  });
  for (const entry of executed) {
    messages.push({
      role: "tool",
      tool_call_id: entry.toolCall.id,
      content: formatToolResult(entry.result),
    });
  }
  for (const problem of problems) {
    messages.push({
      role: "tool",
      tool_call_id: problem.call.id,
      content: `Not run: ${problem.error}`,
    });
  }
}

function sameAction(left: PendingCall, right: PendingCall): boolean {
  return (
    left.tool === right.tool &&
    left.host.serverId === right.host.serverId &&
    left.args.agentId === right.args.agentId &&
    left.args.workspaceId === right.args.workspaceId &&
    left.args.allow === right.args.allow &&
    (left.args.requestId === undefined ||
      right.args.requestId === undefined ||
      left.args.requestId === right.args.requestId) &&
    left.args.mode === right.args.mode
  );
}

/**
 * Creations get an id derived from what they create, so a retry after a timeout (the work
 * kept going on the other host) finds the first one instead of making a second worktree.
 */
function operationIdFor(call: PendingCall): string {
  if (!IDEMPOTENT_BY_CONTENT.has(call.tool)) return uuidv4();
  const bucket = Math.floor(Date.now() / CREATION_DEDUPE_MS);
  const digest = createHash("sha256")
    .update(JSON.stringify([call.host.serverId, call.tool, call.args, bucket]))
    .digest("hex");
  return `voice-${digest.slice(0, 32)}`;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function agentIdOf(target: FleetTarget): string {
  if (target.kind === "agent") return target.agent.agentId;
  if (target.kind === "session") return target.session.agentId;
  throw new RouterInputError("not an agent");
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new RouterInputError(`${key} is missing`);
  return value.trim();
}

function formatToolResult(result: VoiceToolResult): string {
  return [result.ok ? "OK." : "FAILED.", result.text, result.detail ?? ""]
    .filter(Boolean)
    .join("\n");
}

/**
 * A plan answers this request in this conversation. Trailing user lines that are part of the
 * request are left out: they land in the history between planning and delegating.
 */
function planKey(input: RouteInput): string {
  const latest = normalizeSpoken(input.latest);
  const lines = [...input.conversation];
  while (lines.length > 0) {
    const last = lines.at(-1) ?? "";
    const partOfRequest =
      last.startsWith("User:") && latest.includes(normalizeSpoken(last.slice(5)));
    // GPT-Live's "Va." can be committed between planning and the delegation.
    const acknowledgment = last.startsWith("Assistant:") && countWords(last.slice(10)) <= 3;
    if (!partOfRequest && !acknowledgment) break;
    lines.pop();
  }
  return [input.latest.trim(), ...lines.slice(-8)].join("\u0000");
}

function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A yes with no question or condition attached: "dale si es seguro" still needs a yes. */
function isClearApproval(text: string): boolean {
  if (!isSpokenApproval(text)) return false;
  if (text.includes("?") || text.includes("¿")) return false;
  return !/(^|[^\p{L}])(si es|si está|si no|siempre que|if it|if its|if it's|only if|solo si)([^\p{L}]|$)/iu.test(
    text,
  );
}
