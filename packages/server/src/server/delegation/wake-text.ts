import type { SubagentNotificationEntry } from "@getpaseo/protocol/agent-types";

import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { SystemMessage } from "../agent/message-dispatch.js";
import type { DelegationTask } from "./delegation-store.js";

const PER_TASK_RESULT_LIMIT = 4000;
const TOTAL_RESULT_LIMIT = 12000;

export type WakeTask = Pick<
  DelegationTask,
  "id" | "childAgentId" | "title" | "status" | "result" | "createdAt" | "completedAt"
>;

function outcomeVerb(status: DelegationTask["status"]): string {
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "was stopped";
  return "finished";
}

function notificationReason(status: DelegationTask["status"]): SubagentNotificationEntry["reason"] {
  if (status === "failed") return "errored";
  if (status === "cancelled" || status === "interrupted") return "closed";
  return "finished";
}

function settledDurationMs(task: WakeTask): number | null {
  if (!task.completedAt) return null;
  return Date.parse(task.completedAt) - Date.parse(task.createdAt);
}

function subagentEntry(task: WakeTask): SubagentNotificationEntry {
  const durationMs = settledDurationMs(task);
  return {
    agentId: task.childAgentId,
    reason: notificationReason(task.status),
    title: task.title,
    ...(durationMs !== null && durationMs >= 0 ? { durationMs } : {}),
  };
}

function headline(task: WakeTask): string {
  return `Delegated task ${task.id} (agent ${task.childAgentId}, "${task.title}") ${outcomeVerb(task.status)}.`;
}

function fullResultPointer(task: WakeTask): string {
  return `call get_agent_activity with agentId ${task.childAgentId} for the full result`;
}

function responseBlock(task: WakeTask, limit: number, attribute: string): string {
  let text = (task.result ?? "").trim();
  if (text.length > limit) {
    const omitted = text.length - limit;
    text = `${text.slice(0, limit)}\n[truncated ${omitted} chars; ${fullResultPointer(task)}]`;
  }
  return `<agent-response${attribute}>\n${text}\n</agent-response>`;
}

function batchHeader(tasks: readonly WakeTask[], delegatedInCohort: number): string {
  const count =
    delegatedInCohort > tasks.length
      ? `${tasks.length} of ${delegatedInCohort}`
      : `${tasks.length}`;
  const titles = tasks.map((task) => task.title).join(", ");
  return `${count} delegated tasks reported back: ${titles}`;
}

function summarizeWake(tasks: readonly WakeTask[], delegatedInCohort: number): string {
  const [only] = tasks;
  if (tasks.length === 1 && only) {
    return `${only.title} ${outcomeVerb(only.status)}`;
  }
  return batchHeader(tasks, delegatedInCohort);
}

/** The wake for the parent's provider, and the row its timeline shows in place of the prompt. */
export function renderWakeMessage(
  tasks: readonly WakeTask[],
  delegatedInCohort: number,
): SystemMessage {
  return {
    prompt: renderWakePrompt(tasks, delegatedInCohort),
    notification: {
      level: "info",
      message: summarizeWake(tasks, delegatedInCohort),
      source: { kind: "subagent", subagents: tasks.map(subagentEntry) },
    },
  };
}

/**
 * The prompt that wakes a parent. Results are inlined (capped) so the parent rarely needs a
 * follow-up read; the full text stays readable through get_agent_activity.
 */
function renderWakePrompt(tasks: readonly WakeTask[], delegatedInCohort: number): string {
  const [only] = tasks;
  if (tasks.length === 1 && only) {
    return formatSystemNotificationPrompt(
      `${headline(only)}\n\n${responseBlock(only, PER_TASK_RESULT_LIMIT, "")}`,
    );
  }
  const sections = [batchHeader(tasks, delegatedInCohort)];
  let budget = TOTAL_RESULT_LIMIT;
  for (const task of tasks) {
    const limit = Math.min(PER_TASK_RESULT_LIMIT, budget);
    if (limit <= 0) {
      sections.push(`${headline(task)} Result omitted; ${fullResultPointer(task)}.`);
      continue;
    }
    budget -= Math.min((task.result ?? "").trim().length, limit);
    sections.push(`${headline(task)}\n${responseBlock(task, limit, ` task="${task.id}"`)}`);
  }
  return formatSystemNotificationPrompt(sections.join("\n\n"));
}
