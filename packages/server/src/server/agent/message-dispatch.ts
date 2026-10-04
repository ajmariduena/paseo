import type { Logger } from "pino";

import { AgentRunActiveError, type ActiveRun, type AgentManager } from "./agent-manager.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { startAgentRun, type StartAgentRunOptions } from "./agent-prompt.js";

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

/**
 * `system` messages (finish notifications, wakes) never interrupt or replace a turn: they
 * steer into a running turn when `maySteer` and the provider can steer, otherwise they wait
 * for the turn to settle.
 */
export type DispatchPolicy =
  | { kind: "intent"; intent: DispatchIntent }
  | { kind: "system"; maySteer: boolean };

export type MessageDisposition = "steered" | "started" | "out_of_band" | "skipped_archived";

export interface DispatchAgentMessageParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  prompt: AgentPromptInput;
  messageId: string;
  policy: DispatchPolicy;
  logger: Logger;
}

export async function dispatchAgentMessage(
  params: DispatchAgentMessageParams,
): Promise<MessageDisposition> {
  if (params.policy.kind === "system" && (await isArchived(params))) {
    return "skipped_archived";
  }
  await loadAgent(params);
  const mode = resolveMode(params);
  switch (mode.kind) {
    case "steer":
      return await steer(params);
    case "restart":
      return await start(params, { replaceRunning: true });
    case "start":
    case "queue":
      return await startWhenIdle(params);
  }
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

async function steer(params: DispatchAgentMessageParams): Promise<MessageDisposition> {
  if (params.policy.kind === "intent" && params.policy.intent === "steer") {
    try {
      return await start(params, { activeTurnBehavior: "steer" });
    } catch (error) {
      if (!(error instanceof AgentRunActiveError)) throw error;
      return await startWhenIdle(params);
    }
  }
  const result = await params.agentManager.steerAgentRun(params.agentId, params.prompt, {
    clientMessageId: params.messageId,
  });
  if (result.status === "accepted") {
    return "steered";
  }
  // A late steer becomes a new turn carrying the same messageId.
  return await startWhenIdle(params);
}

async function startWhenIdle(params: DispatchAgentMessageParams): Promise<MessageDisposition> {
  for (;;) {
    if (params.agentManager.hasInFlightRun(params.agentId)) {
      params.logger.trace(
        { agentId: params.agentId, messageId: params.messageId },
        "agent.dispatch.wait_for_turn",
      );
    }
    await params.agentManager.waitForRunToSettle(params.agentId);
    if (params.policy.kind === "system" && (await isArchived(params))) {
      return "skipped_archived";
    }
    await loadAgent(params);
    try {
      return await start(params, { replaceRunning: false });
    } catch (error) {
      if (!(error instanceof AgentRunActiveError)) throw error;
    }
  }
}

async function start(
  params: DispatchAgentMessageParams,
  options: Pick<StartAgentRunOptions, "replaceRunning" | "activeTurnBehavior">,
): Promise<MessageDisposition> {
  const { disposition } = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
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
