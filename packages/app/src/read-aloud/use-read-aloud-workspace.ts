import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { useReadAloudStore, type ReadAloudStatus } from "./player";

/** The read-aloud status when the message being read belongs to an agent in this workspace. */
export function useReadAloudWorkspaceStatus(
  serverId: string,
  workspaceId: string,
): ReadAloudStatus | null {
  const track = useReadAloudStore((state) => state.track);
  const status = useReadAloudStore((state) => state.status);
  const agentWorkspaceId = useSessionStore(
    useCallback(
      (state) => {
        if (!track || track.serverId !== serverId) return null;
        const session = state.sessions[serverId];
        const agent =
          session?.agents.get(track.agentId) ?? session?.agentDetails.get(track.agentId);
        return agent?.workspaceId ?? null;
      },
      [track, serverId],
    ),
  );
  if (!status || !agentWorkspaceId) return null;
  return normalizeWorkspaceOpaqueId(agentWorkspaceId) === normalizeWorkspaceOpaqueId(workspaceId)
    ? status
    : null;
}
