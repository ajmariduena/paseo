import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import { AgentManager, type AgentManagerOptions } from "../agent/agent-manager.js";
import { startAgentRun } from "../agent/agent-prompt.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

import type {
  AgentPersistenceHandle,
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
  readonly startPrompts: AgentPromptInput[] = [];
  readonly steerPrompts: AgentPromptInput[] = [];
  interruptCount = 0;
  activeTurnId: string | null = null;
  /** Runs synchronously right before a prompt is dispatched, after the dispatch decision. */
  beforeDispatch: ((prompt: AgentPromptInput) => void) | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  private pendingTurnStart: { turnId: string; timer: NodeJS.Timeout } | null = null;

  constructor(
    readonly provider: AgentProvider,
    readonly id: string = randomUUID(),
    /** Timeline events replayed by `streamHistory`, shared with later resumes of this id. */
    private readonly history: AgentStreamEvent[] = [],
  ) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.startPrompts.push(prompt);
    const turnId = `turn-${++this.turnCounter}`;
    if (typeof prompt === "string") {
      this.history.push({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "user_message", text: prompt },
      });
    }
    this.activeTurnId = turnId;
    this.pendingTurnStart = { turnId, timer: setTimeout(() => this.flushTurnStart(), 0) };
    return { turnId };
  }

  /** A provider never reports a turn's start after its end. */
  private flushTurnStart(): void {
    const pending = this.pendingTurnStart;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTurnStart = null;
    this.push({ type: "turn_started", provider: this.provider, turnId: pending.turnId });
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

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* this.history.slice();
  }

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
    this.flushTurnStart();
    this.activeTurnId = null;
    this.push({ type: "turn_canceled", provider: this.provider, turnId, reason: "interrupted" });
  }

  async close(): Promise<void> {}

  protected push(event: AgentStreamEvent): void {
    if (event.type === "timeline") {
      this.history.push(event);
    }
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  private requireActiveTurn(): string {
    if (!this.activeTurnId) {
      throw new Error("No active turn");
    }
    this.flushTurnStart();
    return this.activeTurnId;
  }
}

export class SteerableControlledAgentSession extends ControlledAgentSession {
  /**
   * `late` ends the turn before the steer lands, as a provider racing its own completion.
   * `busy` refuses input without letting the turn be replaced, as Claude does while compacting.
   */
  steerOutcome: "accepted" | "late" | "busy" = "accepted";

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
    if (this.steerOutcome === "busy") {
      return { status: "busy" };
    }
    this.steerPrompts.push(prompt);
    return { status: "accepted" };
  }
}

export class ControlledAgentClient implements AgentClient {
  readonly capabilities = CAPABILITIES;
  readonly sessions: ControlledAgentSession[] = [];

  /**
   * Pass the same `histories` to a client in a second daemon to resume sessions across a
   * restart with their timeline.
   */
  constructor(
    readonly provider: AgentProvider,
    private readonly options: {
      steerable: boolean;
      histories?: Map<string, AgentStreamEvent[]>;
    },
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    return this.openSession(randomUUID());
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    return this.openSession(handle.sessionId);
  }

  /** The session the agent with this persistence id runs on in this client. */
  sessionFor(sessionId: string): ControlledAgentSession {
    const session = this.sessions.findLast((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new Error(`No ${this.provider} session ${sessionId}`);
    }
    return session;
  }

  private openSession(sessionId: string): ControlledAgentSession {
    const histories = this.options.histories;
    const history = histories?.get(sessionId) ?? [];
    histories?.set(sessionId, history);
    const session = this.options.steerable
      ? new SteerableControlledAgentSession(this.provider, sessionId, history)
      : new ControlledAgentSession(this.provider, sessionId, history);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "controlled", label: "Controlled", isDefault: true }],
      modes: [],
    };
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
export function createControlledHost(
  options: Pick<AgentManagerOptions, "handoffOwnership" | "messageQueueStore"> = {},
): ControlledHost {
  const root = mkdtempSync(join(tmpdir(), "paseo-controlled-host-"));
  const logger = createTestLogger();
  const steerableClient = new ControlledAgentClient("codex", { steerable: true });
  const plainClient = new ControlledAgentClient("claude", { steerable: false });
  const agentStorage = new AgentStorage(join(root, "agents"), logger);
  const agentManager = new AgentManager({
    ...options,
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
      // Queued wakes can resume sessions while teardown closes their previous runtime.
      // Freeze registration before taking the snapshot, then drain before deleting storage.
      agentManager.prepareForShutdown();
      for (const agent of agentManager.listAgents()) {
        await agentManager.closeAgent(agent.id).catch(() => undefined);
      }
      await agentManager.flushForShutdown();
      await agentStorage.flush();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface TraceRecorder {
  logger: Logger;
  /** Resolves once `count` log records with this message have been written. */
  waitFor(message: string, count?: number): Promise<void>;
}

/** A trace-level logger whose records tests can wait on, for decisions with no other signal. */
export function createTraceRecorder(): TraceRecorder {
  const counts = new Map<string, number>();
  const waiters = new Set<{ message: string; count: number; resolve: () => void }>();
  const logger = pino(
    { level: "trace" },
    {
      write(line: string) {
        const { msg } = JSON.parse(line) as { msg: string };
        const seen = (counts.get(msg) ?? 0) + 1;
        counts.set(msg, seen);
        for (const waiter of waiters) {
          if (waiter.message === msg && seen >= waiter.count) {
            waiters.delete(waiter);
            waiter.resolve();
          }
        }
      },
    },
  );
  return {
    logger,
    waitFor(message, count = 1) {
      if ((counts.get(message) ?? 0) >= count) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.add({ message, count, resolve });
      });
    },
  };
}
