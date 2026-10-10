import type { AgentBackgroundTask, AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { RestartCancelledWork } from "../agent/agent-storage.js";

const MAX_LABEL_LENGTH = 160;
const MAX_NOTE_ENTRIES = 10;

function compactLabel(value: string): string | null {
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
}

export function cancelledWorkFromTasks(
  tasks: readonly AgentBackgroundTask[],
): RestartCancelledWork[] {
  return tasks.map((task) => ({
    kind: task.taskType,
    label: compactLabel(task.description) ?? task.id,
    id: task.id,
  }));
}

/** Bounded, so it cannot crowd out the turn it rides on. Port of T3 `RestartBackgroundNote`. */
export function restartCancelledWorkNote(work: readonly RestartCancelledWork[]): string {
  const omitted = work.length - MAX_NOTE_ENTRIES;
  const visible = work.slice(0, MAX_NOTE_ENTRIES);
  const handoff = visible.filter((entry) => entry.kind === "handoff_pull_request_watch");
  const restarted = visible.filter((entry) => entry.kind !== "handoff_pull_request_watch");
  return [
    ...(restarted.length
      ? [
          "Note: the Paseo daemon restarted, and this background work was cancelled before it finished. It will not report back:",
          ...restarted.map((entry) => `- ${entry.kind}: ${entry.label}`),
        ]
      : []),
    ...(handoff.length
      ? [
          "Note: these PR watches were stopped for the workspace handoff. They have not been restarted:",
          ...handoff.map((entry) => `- ${entry.label}`),
        ]
      : []),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
  ].join("\n");
}

export function prependRestartNote(
  prompt: AgentPromptInput,
  work: readonly RestartCancelledWork[],
): AgentPromptInput {
  const note = restartCancelledWorkNote(work);
  if (typeof prompt === "string") return `${note}\n\n${prompt}`;
  return [{ type: "text", text: note }, ...prompt];
}
