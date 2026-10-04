import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export interface AgentModelLabel {
  model: string | null;
  account: string | null;
}

/**
 * The model an agent runs, and the account it runs on when that is not the builtin provider.
 * A custom provider is how Paseo spells "another account": it extends a builtin with its own
 * credentials, so its label is what tells two Claude agents apart.
 */
export function formatAgentModelLabel(
  agent: { provider: string; model: string | null },
  entries: readonly ProviderSnapshotEntry[] | undefined,
): AgentModelLabel {
  const entry = entries?.find((candidate) => candidate.provider === agent.provider);
  const modelId = agent.model?.trim() || null;
  const definition = modelId
    ? entry?.models?.find(
        (candidate) => candidate.id === modelId || candidate.aliases?.includes(modelId),
      )
    : undefined;
  const account = entry?.source === "custom" ? entry.label?.trim() || entry.provider : null;
  return { model: definition?.label ?? modelId, account };
}

/** "{model} · {account}" — the provider icon already names the provider, so the model leads. */
export function joinAgentModelLabel(label: AgentModelLabel): string | null {
  const parts = [label.model, label.account].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
