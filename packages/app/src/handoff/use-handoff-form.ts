import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { openHandoffForm } from "./form-model";
import type { HandoffOrigin } from "./persistence";
import { handoffFormPorts, loadSavedHandoff } from "./runtime";

function savedHandoffQueryKey(origin: HandoffOrigin) {
  return ["saved-handoff", origin.sourceServerId, origin.workspaceId];
}

export function useHandoffAvailable(origin: HandoffOrigin): boolean {
  const supported = useSessionStore(
    (state) =>
      state.sessions[origin.sourceServerId]?.serverInfo?.features?.workspaceHandoff === true,
  );
  const saved = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    networkMode: "always",
    queryKey: savedHandoffQueryKey(origin),
    queryFn: () => loadSavedHandoff(origin),
    enabled: !supported,
    retry: false,
  });
  // Recovery stays reachable offline; damaged local records open the form's visible load error.
  return supported || saved.isError || Boolean(saved.data);
}

export function useHandoffForm(origin: HandoffOrigin) {
  const queryClient = useQueryClient();
  const [model] = useState(() =>
    openHandoffForm(origin, {
      ...handoffFormPorts,
      async save(record) {
        await handoffFormPorts.save(record);
        queryClient.setQueryData(savedHandoffQueryKey(origin), record);
      },
      async discard(recordOrigin) {
        await handoffFormPorts.discard(recordOrigin);
        queryClient.setQueryData(savedHandoffQueryKey(recordOrigin), null);
      },
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => {
    void model.load();
    return () => model.close();
  }, [model]);
  return { model, state };
}
