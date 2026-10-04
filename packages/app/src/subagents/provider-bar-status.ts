import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export type ProviderSubagentBarStatus =
  | { kind: "starting" }
  | { kind: "working"; since: Date }
  | { kind: "completed"; durationMs: number }
  | { kind: "failed" }
  | { kind: "stopped" };

/**
 * What the read-only pane's bar says about the subagent. Timing reads the descriptor's
 * `createdAt` and, once it settles, its last update: the descriptor carries no start or end of
 * its own.
 */
export function resolveProviderSubagentBarStatus(
  descriptor: Pick<ProviderSubagentDescriptorPayload, "status" | "createdAt" | "updatedAt"> | null,
): ProviderSubagentBarStatus {
  if (!descriptor) return { kind: "starting" };
  const createdAt = new Date(descriptor.createdAt);
  switch (descriptor.status) {
    case "running":
      return { kind: "working", since: createdAt };
    case "completed":
      return {
        kind: "completed",
        durationMs: Math.max(0, new Date(descriptor.updatedAt).getTime() - createdAt.getTime()),
      };
    case "failed":
      return { kind: "failed" };
    case "canceled":
      return { kind: "stopped" };
  }
}

/** The tab "Open parent" goes to: the managed agent, or the provider subagent that started it. */
export function resolveProviderSubagentParentTarget(input: {
  parentAgentId: string;
  parentSubagentId: string | null | undefined;
}): WorkspaceTabTarget {
  if (input.parentSubagentId) {
    return {
      kind: "provider_subagent",
      parentAgentId: input.parentAgentId,
      subagentId: input.parentSubagentId,
    };
  }
  return { kind: "agent", agentId: input.parentAgentId };
}
