import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  hydratePendingWorkspaceCreations,
  isLocalPendingWorkspaceCreation,
  usePendingWorkspaceCreationStore,
} from "@/stores/pending-workspace-creation";
import { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

interface Observation {
  client: DaemonClient;
  stop: () => void;
}

function reconcileSnapshot(key: string, snapshot: CreationSnapshot | null): void {
  const store = usePendingWorkspaceCreationStore.getState();
  const creation = store.byKey[key];
  if (!creation) return;
  if (!snapshot) {
    store.update(key, { phase: "failed", error: null, outcomeUnknown: true });
    return;
  }
  if (snapshot.workspaceId !== creation.workspaceId) return;
  if (snapshot.workspace) {
    getHostRuntimeStore().acceptWorkspaceSnapshots(creation.serverId, [
      { ...normalizeWorkspaceDescriptor(snapshot.workspace), status: "running" },
    ]);
  }
  if (snapshot.phase === "failed") {
    store.update(key, {
      phase: "failed",
      revision: snapshot.revision,
      error: snapshot.error,
      outcomeUnknown: snapshot.outcomeUnknown === true,
    });
    return;
  }
  if (snapshot.agent && snapshot.agentId) {
    prepareWorkspaceTab({
      serverId: creation.serverId,
      workspaceId: creation.workspaceId,
      target: { kind: "agent", agentId: snapshot.agentId },
    });
  }
  if (snapshot.phase === "completed") {
    store.remove(key);
    return;
  }
  store.update(key, {
    phase: snapshot.workspace ? "workspace_ready" : "accepted",
    revision: snapshot.revision,
    error: null,
  });
}

export function PendingWorkspaceCreationReconciler() {
  useEffect(() => {
    const runtime = getHostRuntimeStore();
    const observations = new Map<string, Observation>();
    function sync() {
      const state = usePendingWorkspaceCreationStore.getState();
      if (!state.hydrated) return;
      for (const [key, observation] of observations) {
        const creation = state.byKey[key];
        if (!creation || creation.phase === "failed" || isLocalPendingWorkspaceCreation(key)) {
          observation.stop();
          observations.delete(key);
        }
      }
      for (const [key, creation] of Object.entries(state.byKey)) {
        if (creation.phase === "failed" || isLocalPendingWorkspaceCreation(key)) continue;
        const client = runtime.getClient(creation.serverId);
        if (!client) continue;
        const current = observations.get(key);
        if (current?.client === client) continue;
        current?.stop();
        const stop = client.observeCreation(
          "workspace",
          creation.draftId,
          (snapshot) => reconcileSnapshot(key, snapshot),
          () => {
            observations.get(key)?.stop();
            observations.delete(key);
          },
        );
        observations.set(key, { client, stop });
      }
    }
    const stopStore = usePendingWorkspaceCreationStore.subscribe(sync);
    const stopRuntime = runtime.subscribeAll(sync);
    void hydratePendingWorkspaceCreations().then(sync, sync);
    sync();
    return () => {
      stopStore();
      stopRuntime();
      for (const observation of observations.values()) observation.stop();
    };
  }, []);
  return null;
}
