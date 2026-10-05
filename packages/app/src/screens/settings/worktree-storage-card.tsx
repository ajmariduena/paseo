import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type {
  WorkspaceStorageListResponse,
  WorkspaceStorageCleanupResponse,
} from "@getpaseo/protocol/messages";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

interface Props {
  serverId: string;
}

type Entry = WorkspaceStorageListResponse["payload"]["entries"][number];
type CleanupResult = WorkspaceStorageCleanupResponse["payload"]["results"][number];

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatStorageTotals(
  data: WorkspaceStorageListResponse["payload"] | undefined,
  isError: boolean,
): string {
  if (isError) return "Unable to load worktree storage";
  if (!data) return "Loading worktree storage…";
  const estimate = data.sizesComplete ? "" : "At least ";
  return `${estimate}${formatBytes(data.totalBytes)} in ${data.entries.length} worktrees · ${estimate.toLowerCase()}${formatBytes(data.freeableBytes)} can be freed`;
}

function WorktreeRow({
  entry,
  selected,
  onToggle,
}: {
  entry: Entry;
  selected: boolean;
  onToggle?: (entryId: string) => void;
}) {
  const accessibilityState = useMemo(() => ({ checked: selected }), [selected]);
  const toggle = useCallback(() => onToggle?.(entry.entryId), [entry.entryId, onToggle]);
  const content = (
    <View style={styles.item}>
      <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
        <Text style={styles.checkmark}>{selected ? "✓" : ""}</Text>
      </View>
      <View style={styles.itemContent}>
        <Text style={styles.itemName}>{entry.name}</Text>
        <Text style={styles.itemReason}>
          {entry.project ? `${entry.project} · ` : ""}
          {entry.reason}
        </Text>
      </View>
      <Text style={styles.itemSize}>
        {entry.sizeBytes === null ? "…" : formatBytes(entry.sizeBytes)}
      </Text>
    </View>
  );
  if (!onToggle) return <View testID={`worktree-storage-kept-${entry.entryId}`}>{content}</View>;
  return (
    <Pressable
      onPress={toggle}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      accessibilityLabel={`${entry.name}, ${entry.reason}`}
      testID={`worktree-storage-select-${entry.entryId}`}
    >
      {content}
    </Pressable>
  );
}

export function WorktreeStorageCard({ serverId }: Props) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [results, setResults] = useState<CleanupResult[]>([]);
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
    enabled: connected && client !== null,
    refetchInterval: (active) => (active.state.data?.sizesComplete === false ? 3_000 : false),
  });

  const entries = query.data?.entries ?? [];
  const freeable = entries.filter((entry) => entry.freeable);
  const kept = entries.filter((entry) => !entry.freeable);
  const selectedIds = selection ?? new Set(freeable.map((entry) => entry.entryId));
  const selected = freeable.filter((entry) => selectedIds.has(entry.entryId));
  const selectedBytes = selected.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const freeableShare = query.data?.totalBytes
    ? Math.min(100, (query.data.freeableBytes / query.data.totalBytes) * 100)
    : 0;
  const freeableBarStyle = useMemo(
    () => ({ width: `${freeableShare}%` as const }),
    [freeableShare],
  );
  const totalLabel = formatStorageTotals(query.data, query.isError);

  const removeSelected = useCallback(async () => {
    if (!client || selected.length === 0) return;
    setRemoving(true);
    setActionError(null);
    try {
      const response = await client.cleanupWorktreeStorage(selected.map((entry) => entry.entryId));
      if (response.error) throw new Error(response.error);
      setResults(response.results);
      setSelection(
        new Set(
          response.results.filter((result) => !result.removed).map((result) => result.entryId),
        ),
      );
      await queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRemoving(false);
    }
  }, [client, queryClient, queryKey, selected]);

  const close = useCallback(() => {
    setOpen(false);
    setSelection(null);
    setResults([]);
    setActionError(null);
  }, []);
  const openSheet = useCallback(() => {
    setOpen(true);
    void query.refetch();
  }, [query]);
  const toggle = useCallback(
    (entryId: string) => {
      setSelection((current) => {
        const next = new Set(current ?? freeable.map((entry) => entry.entryId));
        if (next.has(entryId)) next.delete(entryId);
        else next.add(entryId);
        return next;
      });
    },
    [freeable],
  );
  const header = useMemo(
    () => ({
      title: `Free ${query.data?.sizesComplete ? "" : "at least "}${formatBytes(selectedBytes)}`,
      subtitle: `${freeable.length} unused worktrees. Branches are kept, so you can recreate any of them.`,
    }),
    [selectedBytes, freeable.length, query.data?.sizesComplete],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="ghost" size="sm" onPress={close}>
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={removing || selected.length === 0}
          onPress={removeSelected}
          testID="worktree-storage-remove"
        >
          {removing
            ? "Removing…"
            : `Remove ${selected.length} ${selected.length === 1 ? "worktree" : "worktrees"}`}
        </Button>
      </View>
    ),
    [close, removing, selected.length, removeSelected],
  );

  if (!connected) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-worktree-storage-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Worktree storage</Text>
            <Text style={settingsStyles.rowHint} testID="worktree-storage-totals">
              {totalLabel}
            </Text>
            {query.data && !query.data.sizesComplete ? (
              <Text style={settingsStyles.rowHint}>Calculating remaining sizes…</Text>
            ) : null}
            {query.data?.sizesComplete && query.data.totalBytes > 0 ? (
              <View style={styles.storageBar}>
                <View style={[styles.freeableBar, freeableBarStyle]} />
              </View>
            ) : null}
          </View>
          <Button variant="outline" size="sm" onPress={openSheet} testID="worktree-storage-open">
            Clean up…
          </Button>
        </View>
      </View>
      {open ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={close}
          testID="worktree-storage-sheet"
          desktopMaxWidth={560}
          footer={footer}
        >
          {query.isPending ? <Text style={styles.empty}>Loading worktrees…</Text> : null}
          {query.isError ? (
            <Text style={settingsStyles.rowError}>{query.error.message}</Text>
          ) : null}
          {actionError ? <Text style={settingsStyles.rowError}>{actionError}</Text> : null}
          {results
            .filter((result) => !result.removed)
            .map((result) => (
              <Text
                key={result.entryId}
                style={settingsStyles.rowError}
                testID={`worktree-storage-error-${result.entryId}`}
              >
                {entries.find((entry) => entry.entryId === result.entryId)?.name ?? result.entryId}:{" "}
                {result.error}
              </Text>
            ))}
          <Text style={styles.group}>Will be removed</Text>
          {freeable.length === 0 ? (
            <Text style={styles.empty}>No worktrees are ready to remove.</Text>
          ) : null}
          {freeable.map((entry) => (
            <WorktreeRow
              key={entry.entryId}
              entry={entry}
              selected={selectedIds.has(entry.entryId)}
              onToggle={toggle}
            />
          ))}
          <Text style={styles.group}>Kept</Text>
          {kept.map((entry) => (
            <WorktreeRow key={entry.entryId} entry={entry} selected={false} />
          ))}
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[3],
  },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  itemContent: { flex: 1, minWidth: 0 },
  itemName: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  itemReason: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  itemSize: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  storageBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface3,
    marginTop: theme.spacing[3],
    overflow: "hidden",
  },
  freeableBar: { height: 6, backgroundColor: theme.colors.accent },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  checkboxSelected: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  checkmark: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, textAlign: "center" },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    width: "100%",
  },
}));
