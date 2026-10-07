import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { NotesScreen } from "@/screens/notes-screen";

export default function NotesRoute() {
  const params = useLocalSearchParams<{ serverId?: string; noteId?: string }>();
  const initialSelection = useMemo(
    () =>
      params.serverId && params.noteId
        ? { serverId: params.serverId, noteId: params.noteId }
        : null,
    [params.noteId, params.serverId],
  );
  return (
    <HostRouteBootstrapBoundary>
      <NotesScreen initialSelection={initialSelection} />
    </HostRouteBootstrapBoundary>
  );
}
