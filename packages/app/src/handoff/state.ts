import { useSessionStore } from "@/stores/session-store";
import { selectWorkspaceFields } from "@/stores/session-store-hooks/selectors";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

export function useSourceHandoff(serverId: string, workspaceId: string) {
  return useWorkspaceFields(serverId, workspaceId, (workspace) => workspace.handoff);
}

export function useSourceHandoffReadOnly(
  serverId: string,
  workspaceId: string | null | undefined,
): boolean {
  return (
    useWorkspaceFields(serverId, workspaceId ?? null, (workspace) =>
      Boolean(workspace.handoff && workspace.handoff.state !== "cancelled"),
    ) ?? false
  );
}

// Async confirmations and deferred work must check current ownership at dispatch.
export function getSourceHandoffReadOnly(
  serverId: string,
  workspaceId: string | null | undefined,
): boolean {
  return (
    selectWorkspaceFields(useSessionStore.getState(), serverId, workspaceId ?? null, (workspace) =>
      Boolean(workspace.handoff && workspace.handoff.state !== "cancelled"),
    ) ?? false
  );
}
