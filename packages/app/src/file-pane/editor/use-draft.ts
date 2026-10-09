import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { isWeb } from "@/constants/platform";
import { usePaneContext } from "@/panels/pane-context";
import { fileEditorDraftStorage, type FileEditorDraft } from "./drafts";

export function useFileEditorDraft(readTarget: { cwd: string; path: string } | null) {
  const { serverId, workspaceId, tabId } = usePaneContext();
  const queryClient = useQueryClient();
  const identity = useMemo(
    () => (readTarget ? { serverId, workspaceId, tabId, ...readTarget } : null),
    [serverId, workspaceId, tabId, readTarget],
  );
  const queryKey = useMemo(() => ["file-editor-draft", identity], [identity]);
  const enabled = isWeb && identity !== null;
  const query = useFetchQuery({
    dataShape: "value",
    queryKey,
    queryFn: () => (identity ? fileEditorDraftStorage.load(identity) : null),
    enabled,
    staleTimeMs: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const persistDraft = useCallback(
    async (draft: FileEditorDraft | null) => {
      if (!identity) return;
      await fileEditorDraftStorage.save(identity, draft);
      queryClient.setQueryData(queryKey, draft);
    },
    [identity, queryClient, queryKey],
  );
  return { query, enabled, persistDraft, draft: query.data ?? null };
}
