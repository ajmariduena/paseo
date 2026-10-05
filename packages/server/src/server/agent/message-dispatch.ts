import type { Logger } from "pino";

import {
  ActiveTurnChangedError,
  AgentRunActiveError,
  type ActiveRun,
  type AgentManager,
} from "./agent-manager.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { startAgentRun, type StartAgentRunOptions } from "./agent-prompt.js";
import type { NotificationAnnotation } from "./prompt-annotations.js";
import type { MessageOrigin } from "@getpaseo/protocol/agent-types";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type {
  FallbackQueueDeliverer,
  QueueDelivery,
  QueueDeliveryResult,
} from "../agent-queue/runner.js";
import type { NewQueueEntry, QueueWakeRef } from "../agent-queue/store.js";

export type DispatchIntent = "auto" | "steer" | "restart" | "queue";

export type DispatchMode =
  | { kind: "start" }
  | { kind: "steer"; runKey: string }
  | { kind: "restart"; runKey: string }
  | { kind: "queue" };

export interface DispatchTarget {
  run: ActiveRun | null;
  canSteer: boolean;
}

export function resolveDispatchIntent(
  target: DispatchTarget,
  intent: DispatchIntent,
): DispatchMode {
  const { run } = target;
  if (!run) {
    return { kind: "start" };
  }
  switch (intent) {
    case "steer":
      return { kind: "steer", runKey: run.key };
    case "restart":
      return { kind: "restart", runKey: run.key };
    case "queue":
      return { kind: "queue" };
    case "auto":
      if (run.started && target.canSteer) {
        return { kind: "steer", runKey: run.key };
      }
      return { kind: "queue" };
  }
}

/** The provider receives `prompt`; the timeline shows `notification` in its place. */
export interface SystemMessage {
  prompt: string;
  notification: Omit<NotificationAnnotation, "kind">;
}

/** How a waiting system message appears in the agent's queue. */
export type SystemQueueEntry =
  | { origin: "delegation_wake"; wake: QueueWakeRef }
  | { origin: "system" };

/**
 * `system` messages (notifications, wakes) never interrupt or replace a turn: they steer into
 * a running turn when `maySteer` and the provider can steer, otherwise they wait in the queue
 * for the turn to settle. Their text is prepared right before each steer or start, so a
 * message that went stale while waiting is dropped instead of delivered.
 */
export type DispatchPolicy =
  | {
      kind: "intent";
      intent: DispatchIntent;
      prompt: AgentPromptInput;
      /**
       * `replace` keeps the app's steer: a provider that cannot steer gets its turn replaced.
       * `fail` throws SteerUnavailableError instead.
       */
      steerUnavailable: "replace" | "fail";
      /** Omitted for the user's own prompts. */
      origin?: MessageOrigin;
      /** A message from the human answers any permission the agent is blocked on. */
      clearPendingPermissions?: boolean;
      onQueued?: () => void;
    }
  | {
      kind: "system";
      maySteer: boolean;
      prepare: () => Promise<SystemMessage | null>;
      queueAs: SystemQueueEntry;
      onQueued?: () => Promise<void>;
    };

export type MessageDisposition =
  | "steered"
  | "started"
  | "restarted"
  | "out_of_band"
  | "skipped_archived"
  | "dropped";

/** An explicit steer found a running turn whose provider cannot take it without a restart. */
export class SteerUnavailableError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} cannot take a steer into its running turn`);
    this.name = "SteerUnavailableError";
  }
}

const pendingDispatches = new WeakMap<AgentManager, Map<string, Set<string>>>();

function trackPendingDispatch(params: DispatchAgentMessageParams): () => void {
  const byAgent = pendingDispatches.get(params.agentManager) ?? new Map<string, Set<string>>();
  pendingDispatches.set(params.agentManager, byAgent);
  const messageIds = byAgent.get(params.agentId) ?? new Set<string>();
  byAgent.set(params.agentId, messageIds);
  messageIds.add(params.messageId);
  return () => {
    messageIds.delete(params.messageId);
    if (messageIds.size === 0 && byAgent.get(params.agentId) === messageIds) {
      byAgent.delete(params.agentId);
    }
  };
}

/** A message for this agent was dispatched and has not yet steered, started, or been dropped. */
export function hasPendingDispatch(
  agentManager: AgentManager,
  agentId: string,
  messageId?: string,
): boolean {
  const messageIds = pendingDispatches.get(agentManager)?.get(agentId);
  if (!messageIds) return false;
  return messageId === undefined ? messageIds.size > 0 : messageIds.has(messageId);
}

export interface DispatchAgentMessageParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  messageId: string;
  policy: DispatchPolicy;
  logger: Logger;
}

export function toDispatchIntent(behavior: ActiveTurnBehavior): DispatchIntent {
  return behavior === "interrupt" ? "restart" : behavior;
}

export async function dispatchAgentMessage(
  params: DispatchAgentMessageParams,
): Promise<MessageDisposition> {
  const untrack = trackPendingDispatch(params);
  try {
    if (params.policy.kind === "system" && (await isArchived(params))) {
      return "skipped_archived";
    }
    await loadAgent(params);
    const mode = resolveMode(params);
    switch (mode.kind) {
      case "steer":
        return await steer(params, { explicit: isExplicitSteer(params.policy) });
      case "restart": {
        const disposition = await start(params, { replaceRunning: true });
        return disposition === "started" ? "restarted" : disposition;
      }
      case "start":
        return await startOrQueue(params);
      case "queue":
        return await enqueue(params);
    }
  } finally {
    untrack();
  }
}

function isExplicitSteer(policy: DispatchPolicy): boolean {
  return policy.kind === "intent" && policy.intent === "steer";
}

function resolveMode(params: DispatchAgentMessageParams): DispatchMode {
  const agent = params.agentManager.getAgent(params.agentId);
  const target: DispatchTarget = {
    run: params.agentManager.getActiveRun(params.agentId),
    canSteer: Boolean(agent?.session?.steerActiveTurn),
  };
  if (params.policy.kind === "intent") {
    return resolveDispatchIntent(target, params.policy.intent);
  }
  return resolveDispatchIntent(target, params.policy.maySteer ? "auto" : "queue");
}

async function preparePrompt(params: DispatchAgentMessageParams): Promise<AgentPromptInput | null> {
  if (params.policy.kind === "intent") {
    const { prompt, origin } = params.policy;
    if (origin) {
      await params.agentManager.annotatePrompt(params.agentId, {
        messageId: params.messageId,
        prompt,
        annotation: { kind: "origin", origin },
      });
    }
    return prompt;
  }
  const message = await params.policy.prepare();
  if (!message) {
    return null;
  }
  await params.agentManager.annotatePrompt(params.agentId, {
    messageId: params.messageId,
    prompt: message.prompt,
    annotation: { kind: "notification", ...message.notification },
  });
  return message.prompt;
}

/**
 * Never replaces a turn on its own: only an intent policy with `steerUnavailable: "replace"`
 * replaces, and only the turn the steer was admitted against. A turn that ended first makes the
 * message a new turn with the same messageId, or queues it behind a newer run.
 */
async function steer(
  params: DispatchAgentMessageParams,
  options: { explicit: boolean },
): Promise<MessageDisposition> {
  const prompt = await preparePrompt(params);
  if (prompt === null) {
    return "dropped";
  }
  const { policy } = params;
  if (policy.kind === "intent" && policy.steerUnavailable === "replace") {
    return await steerOrReplace(params, prompt);
  }
  const result = await params.agentManager.steerAgentRun(params.agentId, prompt, {
    clientMessageId: params.messageId,
    ...(policy.kind === "intent" && policy.clearPendingPermissions
      ? { clearPendingPermissions: true }
      : {}),
  });
  if (result.status === "accepted") {
    return "steered";
  }
  if (options.explicit && (result.status === "unavailable" || result.status === "busy")) {
    throw new SteerUnavailableError(params.agentId);
  }
  return await startOrQueue(params);
}

async function steerOrReplace(
  params: DispatchAgentMessageParams,
  prompt: AgentPromptInput,
): Promise<MessageDisposition> {
  const clearPendingPermissions =
    params.policy.kind === "intent" && params.policy.clearPendingPermissions === true;
  try {
    const { disposition } = await startAgentRun(
      params.agentManager,
      params.agentId,
      prompt,
      params.logger,
      {
        activeTurnBehavior: "steer",
        clearPendingPermissions,
        runOptions: { clientMessageId: params.messageId },
      },
    );
    return disposition === "turn_started" ? "started" : disposition;
  } catch (error) {
    if (error instanceof AgentRunActiveError || error instanceof ActiveTurnChangedError) {
      return await enqueue(params);
    }
    throw error;
  }
}

async function startOrQueue(params: DispatchAgentMessageParams): Promise<MessageDisposition> {
  const disposition = await tryStart(params);
  return disposition === "busy" ? await enqueue(params) : disposition;
}

async function tryStart(params: DispatchAgentMessageParams): Promise<QueueDeliveryResult> {
  try {
    return await start(params, { replaceRunning: false });
  } catch (error) {
    if (error instanceof AgentRunActiveError) return "busy";
    throw error;
  }
}

/** Waits in the agent's durable queue; resolves once the queue delivered or dropped it. */
async function enqueue(params: DispatchAgentMessageParams): Promise<MessageDisposition> {
  const entry = await queueEntry(params);
  if (!entry) {
    return "dropped";
  }
  const queued = await params.agentManager.messageQueue.enqueue(params.agentId, entry, (delivery) =>
    deliverQueuedMessage(params, delivery),
  );
  params.logger.trace(
    { agentId: params.agentId, messageId: params.messageId },
    "agent.dispatch.wait_for_turn",
  );
  await params.policy.onQueued?.();
  return await queued.settled;
}

async function queueEntry(params: DispatchAgentMessageParams): Promise<NewQueueEntry | null> {
  const { policy } = params;
  if (policy.kind === "intent") {
    const senderAgentId = policy.origin?.kind === "agent" ? policy.origin.agentId : null;
    return {
      id: params.messageId,
      origin: senderAgentId ? "agent" : "user",
      senderAgentId,
      textPreview: "",
      prompt: policy.prompt,
      wake: null,
    };
  }
  // Rendered here only for the queue preview; delivery renders it again from current state.
  const message = await policy.prepare();
  if (!message) {
    return null;
  }
  return {
    id: params.messageId,
    origin: policy.queueAs.origin,
    senderAgentId: null,
    textPreview: message.notification.message,
    prompt: null,
    wake: policy.queueAs.origin === "delegation_wake" ? policy.queueAs.wake : null,
  };
}

/** Starts (or steers) a message the queue handed over; a newer run makes it `busy`. */
export async function deliverQueuedMessage(
  params: DispatchAgentMessageParams,
  delivery: Pick<QueueDelivery, "prompt" | "mode">,
): Promise<QueueDeliveryResult> {
  const queuedParams =
    params.policy.kind === "intent" && delivery.prompt !== null
      ? { ...params, policy: { ...params.policy, prompt: delivery.prompt } }
      : params;
  if (queuedParams.policy.kind === "system" && (await isArchived(queuedParams))) {
    return "skipped_archived";
  }
  await loadAgent(queuedParams);
  if (delivery.mode === "steer") {
    return await steer(queuedParams, { explicit: true });
  }
  return await tryStart(queuedParams);
}

async function start(
  params: DispatchAgentMessageParams,
  options: Pick<StartAgentRunOptions, "replaceRunning" | "activeTurnBehavior">,
): Promise<MessageDisposition> {
  const prompt = await preparePrompt(params);
  if (prompt === null) {
    return "dropped";
  }
  const { disposition } = await startAgentRun(
    params.agentManager,
    params.agentId,
    prompt,
    params.logger,
    { ...options, runOptions: { clientMessageId: params.messageId } },
  );
  return disposition === "turn_started" ? "started" : disposition;
}

async function isArchived(params: DispatchAgentMessageParams): Promise<boolean> {
  const record = await params.agentStorage.get(params.agentId);
  return Boolean(record?.archivedAt);
}

async function loadAgent(params: DispatchAgentMessageParams): Promise<void> {
  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });
}

/**
 * Delivers a queued message that has no in-process sender, such as one that survived a
 * restart. Wakes go back to their delegation; system entries are process-bound and dropped.
 */
export function createRestoredEntryDeliverer(
  deps: Pick<DispatchAgentMessageParams, "agentManager" | "agentStorage" | "logger"> & {
    deliverWake: FallbackQueueDeliverer;
  },
): FallbackQueueDeliverer {
  const { deliverWake, ...dispatchDeps } = deps;
  return async (agentId, delivery) => {
    const { entry, prompt } = delivery;
    if (entry.origin === "delegation_wake") {
      return await deliverWake(agentId, delivery);
    }
    if (prompt === null) {
      deps.logger.info({ agentId, entryId: entry.id }, "agent.queue.dropped_process_bound");
      return "dropped";
    }
    const sender = entry.senderAgentId;
    const params: DispatchAgentMessageParams = {
      ...dispatchDeps,
      agentId,
      messageId: entry.id,
      policy: {
        kind: "intent",
        intent: "queue",
        prompt,
        steerUnavailable: sender ? "fail" : "replace",
        ...(sender ? { origin: { kind: "agent", agentId: sender } } : {}),
        clearPendingPermissions: sender === null,
      },
    };
    return await deliverQueuedMessage(params, delivery);
  };
}

export interface BackgroundDispatch {
  /** `queued` means the message waits for the running turn and keeps going in `settled`. */
  disposition: MessageDisposition | "queued";
  settled: Promise<MessageDisposition>;
}

/** Dispatches an intent and returns as soon as the message steered, started, or got queued. */
export async function dispatchAgentMessageInBackground(
  params: Omit<DispatchAgentMessageParams, "policy"> & {
    policy: Omit<Extract<DispatchPolicy, { kind: "intent" }>, "kind" | "onQueued">;
  },
): Promise<BackgroundDispatch> {
  const { policy, ...rest } = params;
  let markQueued: () => void = () => undefined;
  const queued = new Promise<"queued">((resolve) => {
    markQueued = () => resolve("queued");
  });
  const settled = dispatchAgentMessage({
    ...rest,
    policy: { ...policy, kind: "intent", onQueued: markQueued },
  });
  const disposition = await Promise.race([settled, queued]);
  return { disposition, settled };
}

/** The message is already in flight or in the agent's timeline, so a retry must not resend it. */
export function isMessageAlreadyDispatched(
  agentManager: AgentManager,
  agentId: string,
  messageId: string,
): boolean {
  if (hasPendingDispatch(agentManager, agentId, messageId)) return true;
  if (agentManager.messageQueue.entries(agentId).some((entry) => entry.id === messageId)) {
    return true;
  }
  return agentManager
    .getTimeline(agentId)
    .some(
      (item) =>
        item.type === "user_message" &&
        (item.clientMessageId === messageId || item.messageId === messageId),
    );
}
