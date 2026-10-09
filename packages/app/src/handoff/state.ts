import { useWorkspaceFields } from "@/stores/session-store-hooks";

export function useSourceHandoff(serverId: string, workspaceId: string) {
  return useWorkspaceFields(serverId, workspaceId, (workspace) => workspace.handoff);
}

export function useSourceHandoffReadOnly(serverId: string, workspaceId: string): boolean {
  return (
    useWorkspaceFields(serverId, workspaceId, (workspace) =>
      Boolean(workspace.handoff && workspace.handoff.state !== "cancelled"),
    ) ?? false
  );
}
