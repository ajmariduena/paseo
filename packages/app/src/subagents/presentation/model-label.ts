import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";

export interface AgentModelLabel {
  model: string | null;
  effort: string | null;
  account: string | null;
}

export interface AgentModelLabelInput {
  provider: string;
  model: string | null;
  thinkingOptionId: string | null;
}

/** The model and effort an agent reports running, ahead of the ones it was configured with. */
export function resolveAgentModelLabelInput(agent: {
  provider: string;
  model: string | null;
  thinkingOptionId?: string | null;
  runtimeInfo?: { model?: string | null; thinkingOptionId?: string | null };
}): AgentModelLabelInput {
  return {
    provider: agent.provider,
    model: agent.runtimeInfo?.model ?? agent.model,
    thinkingOptionId: agent.runtimeInfo?.thinkingOptionId ?? agent.thinkingOptionId ?? null,
  };
}

function resolveEffortLabel(
  thinkingOptionId: string | null,
  options: readonly { id: string; label: string }[] | undefined,
): string | null {
  const id = thinkingOptionId?.trim() || null;
  if (!id || id === "default") return null;
  const option = options?.find((candidate) => candidate.id === id) ?? { id };
  return formatThinkingOptionLabel(option);
}

/**
 * The model an agent runs, its effort when it set one, and the account it runs on when that is not
 * the builtin provider. A custom provider is how Paseo spells "another account": it extends a
 * builtin with its own credentials, so its label is what tells two Claude agents apart.
 */
export function formatAgentModelLabel(
  agent: AgentModelLabelInput,
  entries: readonly ProviderSnapshotEntry[] | undefined,
): AgentModelLabel {
  const entry = entries?.find((candidate) => candidate.provider === agent.provider);
  const modelId = agent.model?.trim() || null;
  const definition = modelId
    ? entry?.models?.find(
        (candidate) => candidate.id === modelId || candidate.aliases?.includes(modelId),
      )
    : undefined;
  const effort = resolveEffortLabel(agent.thinkingOptionId, definition?.thinkingOptions);
  const account = entry?.source === "custom" ? entry.label?.trim() || entry.provider : null;
  return { model: definition?.label ?? modelId, effort, account };
}

/**
 * "{model} {effort} · {account}", the order the composer uses. The provider icon already names the
 * provider, so the model leads.
 */
export function joinAgentModelLabel(label: AgentModelLabel): string | null {
  const intelligence = [label.model, label.effort].filter(Boolean).join(" ");
  const parts = [intelligence, label.account].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
