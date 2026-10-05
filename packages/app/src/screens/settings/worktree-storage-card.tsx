import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { WorktreeStorageCardView } from "./worktree-storage-card-view";

interface Props {
  serverId: string;
}

function AutomaticWorktreeCleanupSetting({
  serverId,
  unavailableReason,
}: Props & { unavailableReason: "lsof_missing" | "check_failed" | null }) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [error, setError] = useState<string | null>(null);
  const setAutomaticCleanup = useCallback(
    (enabled: boolean) => {
      setError(null);
      void patchConfig({ autoCleanupArchivedWorktrees: enabled }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [patchConfig],
  );

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Automatically clean archived worktrees</Text>
        <Text style={settingsStyles.rowHint}>
          Periodically remove clean worktrees owned by this host after teardown succeeds. Older and
          unlinked worktrees stay for manual review.
        </Text>
        {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
      </View>
      <Switch
        value={config?.autoCleanupArchivedWorktrees === true}
        onValueChange={setAutomaticCleanup}
        disabled={unavailableReason !== null && config?.autoCleanupArchivedWorktrees !== true}
        accessibilityLabel="Automatically clean archived worktrees"
        testID="worktree-storage-auto-cleanup-switch"
      />
    </View>
  );
}

export function WorktreeStorageCard({ serverId }: Props) {
  const connected = useHostRuntimeIsConnected(serverId);
  if (!connected) return null;
  return <ConnectedWorktreeStorageCard serverId={serverId} />;
}

function AutomaticWorktreeCleanupSection({
  serverId,
  unavailableReason,
}: Props & { unavailableReason: "lsof_missing" | "check_failed" | null }) {
  const supported = useHostFeature(serverId, "autoWorktreeCleanup");
  return supported ? (
    <AutomaticWorktreeCleanupSetting serverId={serverId} unavailableReason={unavailableReason} />
  ) : null;
}

function ConnectedWorktreeStorageCard({ serverId }: Props) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["worktree-storage", serverId], [serverId]);
  const query = useFetchQuery({
    dataShape: "list",
    staleTimeMs: 5_000,
    queryKey,
    queryFn: async () => {
      if (!client) throw new Error("Host is not connected");
      const payload = await client.listWorktreeStorage();
      if (payload.error) throw new Error(payload.error);
      return payload;
    },
    enabled: client !== null,
    refetchInterval: (active) => (active.state.data?.sizesComplete === false ? 3_000 : false),
  });
  const { refetch } = query;
  const onRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const onCleanup = useCallback(
    (entryIds: string[], legacyEntryIds: string[]) => {
      if (!client) throw new Error("Host is not connected");
      return client.cleanupWorktreeStorage(entryIds, legacyEntryIds);
    },
    [client],
  );
  const onAfterCleanup = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return (
    <WorktreeStorageCardView
      data={query.data}
      isPending={query.isPending}
      loadError={query.isError ? query.error.message : null}
      onRefresh={onRefresh}
      onCleanup={onCleanup}
      onAfterCleanup={onAfterCleanup}
    >
      <AutomaticWorktreeCleanupSection
        serverId={serverId}
        unavailableReason={query.data?.processCheckUnavailableReason ?? null}
      />
    </WorktreeStorageCardView>
  );
}
