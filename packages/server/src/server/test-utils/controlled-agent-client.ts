import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import { AgentManager } from "../agent/agent-manager.js";
import { startAgentRun } from "../agent/agent-prompt.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

import type {
  AgentBackgroundTask,
  AgentCapabilityFlags,
  AgentClient,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "../agent/agent-sdk-types.js";

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

/**
 * A provider session whose turns end only when the test says so, so orchestration tests can
 * hold a parent mid-turn while children finish.
 */
export class ControlledAgentSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly startPrompts: AgentPromptInput[] = [];
  readonly steerPrompts: AgentPromptInput[] = [];
  interruptCount = 0;
  activeTurnId: string | null = null;
  /** Runs synchronously right before a prompt is dispatched, after the dispatch decision. */
  beforeDispatch: ((prompt: AgentPromptInput) => void) | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;

  constructor(readonly provider: AgentProvider) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.startPrompts.push(prompt);
    const turnId = `turn-${++this.turnCounter}`;
    this.activeTurnId = turnId;
    setTimeout(() => this.push({ type: "turn_started", provider: this.provider, turnId }), 0);
    return { turnId };
  }

  completeTurn(assistantText?: string): void {
    const turnId = this.requireActiveTurn();
    if (assistantText !== undefined) {
      this.push({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: assistantText },
      });
    }
    this.activeTurnId = null;
    this.push({ type: "turn_completed", provider: this.provider, turnId });
  }

  failTurn(error: string): void {
    const turnId = this.requireActiveTurn();
    this.activeTurnId = null;
    this.push({ type: "turn_failed", provider: this.provider, turnId, error });
  }

  setBackgroundTasks(tasks: AgentBackgroundTask[]): void {
    this.push({ type: "background_tasks_changed", provider: this.provider, tasks });
  }

  tryHandleOutOfBand(prompt: AgentPromptInput): null {
    this.beforeDispatch?.(prompt);
    return null;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.activeTurnId = null;
    this.push({ type: "turn_canceled", provider: this.provider, turnId, reason: "interrupted" });
  }

  async close(): Promise<void> {}

  protected push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  private requireActiveTurn(): string {
    if (!this.activeTurnId) {
      throw new Error("No active turn");
    }
    return this.activeTurnId;
  }
}

export class SteerableControlledAgentSession extends ControlledAgentSession {
  /** `late` ends the turn before the steer lands, as a provider racing its own completion. */
  steerOutcome: "accepted" | "late" = "accepted";

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    if (options.expectedTurnId !== this.activeTurnId) {
      return { status: "unavailable" };
    }
    if (this.steerOutcome === "late") {
      this.completeTurn("finished before the steer landed");
      return { status: "unavailable" };
    }
    this.steerPrompts.push(prompt);
    return { status: "accepted" };
  }
}

export class ControlledAgentClient implements AgentClient {
  readonly capabilities = CAPABILITIES;
  readonly sessions: ControlledAgentSession[] = [];

  constructor(
    readonly provider: AgentProvider,
    private readonly options: { steerable: boolean },
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = this.options.steerable
      ? new SteerableControlledAgentSession(this.provider)
      : new ControlledAgentSession(this.provider);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  latestSession(): ControlledAgentSession {
    const session = this.sessions.at(-1);
    if (!session) {
      throw new Error(`No ${this.provider} session created`);
    }
    return session;
  }
}

export interface ControlledHost {
  root: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  createAgent(input: ControlledAgentInput): Promise<string>;
  /** Starts a foreground turn and resolves once the provider accepted it. */
  startTurn(agentId: string, prompt: string): Promise<void>;
  session(agentId: string): ControlledAgentSession;
  cleanup(): Promise<void>;
}

export interface ControlledAgentInput {
  steerable: boolean;
  labels?: Record<string, string>;
}

/**
 * A real AgentManager and AgentStorage on a temp directory. Steerable agents run on the
 * `codex` provider, non-steerable ones on `claude`.
 */
export function createControlledHost(): ControlledHost {
  const root = mkdtempSync(join(tmpdir(), "paseo-controlled-host-"));
  const logger = createTestLogger();
  const steerableClient = new ControlledAgentClient("codex", { steerable: true });
  const plainClient = new ControlledAgentClient("claude", { steerable: false });
  const agentStorage = new AgentStorage(join(root, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { codex: steerableClient, claude: plainClient },
    registry: agentStorage,
    logger,
  });
  const sessions = new Map<string, ControlledAgentSession>();

  return {
    root,
    agentManager,
    agentStorage,
    logger,
    async createAgent(input) {
      const client = input.steerable ? steerableClient : plainClient;
      const snapshot = await agentManager.createAgent(
        { provider: client.provider, cwd: root },
        undefined,
        { workspaceId: undefined, ...(input.labels ? { labels: input.labels } : {}) },
      );
      sessions.set(snapshot.id, client.latestSession());
      return snapshot.id;
    },
    async startTurn(agentId, prompt) {
      await startAgentRun(agentManager, agentId, prompt, logger);
      await agentManager.waitForAgentRunStart(agentId);
    },
    session(agentId) {
      const session = sessions.get(agentId);
      if (!session) {
        throw new Error(`No session for agent ${agentId}`);
      }
      return session;
    },
    async cleanup() {
      for (const agentId of sessions.keys()) {
        await agentManager.closeAgent(agentId).catch(() => undefined);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface TraceRecorder {
  logger: Logger;
  /** Resolves once a log record with this message has been written. */
  waitFor(message: string): Promise<void>;
}

/** A trace-level logger whose records tests can wait on, for decisions with no other signal. */
export function createTraceRecorder(): TraceRecorder {
  const seen = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();
  const logger = pino(
    { level: "trace" },
    {
      write(line: string) {
        const { msg } = JSON.parse(line) as { msg: string };
        seen.add(msg);
        for (const resolve of waiters.get(msg) ?? []) resolve();
        waiters.delete(msg);
      },
    },
  );
  return {
    logger,
    waitFor(message) {
      if (seen.has(message)) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.set(message, [...(waiters.get(message) ?? []), resolve]);
      });
    },
  };
}
