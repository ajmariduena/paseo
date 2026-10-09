import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useFetchQueries } from "@/data/query";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AgentStreamView } from "@/agent-stream/view";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  PaneProvider,
  PaneFocusProvider,
  usePaneContext,
  usePaneFocus,
} from "@/panels/pane-context";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { processTimelineResponse, type TimelineCursor } from "@/timeline/session-stream-reducers";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";

type History = NonNullable<
  Awaited<ReturnType<DaemonClient["handoffGetConversationHistory"]>>["result"]
>;
interface PageParam {
  cursor?: NonNullable<Parameters<DaemonClient["handoffGetConversationHistory"]>[0]["cursor"]>;
}
interface Props {
  serverId: string;
  agentId: string;
}
const FIRST_PAGE: PageParam = {};
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const IDLE_TURN = { isActive: false, isCancelling: false, startedAt: null, turnId: null };
const SNAP_POINTS = ["90%"];

function projectHistory(agentId: string, pages: History[]) {
  let tail: StreamItem[] = [];
  let head: StreamItem[] = [];
  let cursor: TimelineCursor | undefined;
  for (const page of pages) {
    const result = processTimelineResponse({
      payload: { ...page.timeline, agentId, error: null },
      currentTail: tail,
      currentHead: head,
      currentCursor: cursor,
      isInitializing: cursor === undefined,
      hasActiveInitDeferred: cursor === undefined,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
    });
    tail = result.tail;
    head = result.head;
    cursor = result.cursor ?? undefined;
  }
  return { tail, head };
}

function HistoryContent({ serverId, agentId, onClose }: Props & { onClose: () => void }) {
  const { t } = useTranslation();
  const pane = usePaneContext();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const hosts = useHosts();
  const [pageParams, setPageParams] = useState<PageParam[]>([FIRST_PAGE]);
  const queries = useFetchQueries<History>(
    pageParams.map((pageParam) => ({
      queryKey: ["handoff-history", serverId, agentId, pageParam],
      queryFn: async () => {
        if (!client) throw new Error(t("handoff.historyConnect"));
        const reply = await client.handoffGetConversationHistory({
          agentId,
          ...pageParam,
          limit: 100,
        });
        if (reply.error) throw new Error(reply.error.message);
        if (!reply.result) throw new Error(t("handoff.historyUnavailable"));
        return reply.result;
      },
      dataShape: "value",
      immutableWhen: () => true,
      retry: false,
    })),
  );
  const history = queries[0].data;
  const openSourceTarget = useCallback(
    (target: WorkspaceTabTarget) => {
      if (!history) return;
      onClose();
      navigateToWorkspace({
        serverId: history.sourceServerId,
        workspaceId: history.sourceWorkspaceId,
        target,
      });
    },
    [history, onClose],
  );
  const historyPane = useMemo(() => {
    if (!history) return null;
    const target: WorkspaceTabTarget = { kind: "agent", agentId: history.sourceAgentId };
    // Message attribution and provider-child links also read pane context. They
    // must not inherit the destination's host or its tab-opening callback.
    return {
      ...pane,
      serverId: history.sourceServerId,
      workspaceId: history.sourceWorkspaceId,
      tabId: buildDeterministicWorkspaceTabId(target),
      target,
      openTab: openSourceTarget,
      openPreferredTarget: openSourceTarget,
      openTargetToSide: openSourceTarget,
    };
  }, [history, pane, openSourceTarget]);
  const last = queries[queries.length - 1];
  const failed = queries.find((query) => query.error);
  const streamId = `handoff-history:${agentId}`;
  const stream = useMemo(
    () =>
      projectHistory(
        streamId,
        queries.flatMap((query) => (query.data ? [query.data] : [])),
      ),
    [queries, streamId],
  );
  const context = useMemo<AgentScreenAgent | null>(
    () =>
      history
        ? {
            id: streamId,
            serverId: history.sourceServerId,
            provider: history.provider,
            cwd: history.sourceCwd,
            workspaceId: history.sourceWorkspaceId,
            status: "closed",
          }
        : null,
    [history, streamId],
  );
  const oldest = last.data?.timeline.startCursor;
  const hasOlder = last.data?.timeline.hasOlder === true;
  const isLoadingOlder = last.isFetching;
  const loadOlder = useCallback(() => {
    if (!oldest || !hasOlder || isLoadingOlder || failed) return false;
    setPageParams((current) =>
      current.some((page) => page.cursor?.epoch === oldest.epoch && page.cursor.seq === oldest.seq)
        ? current
        : [...current, { cursor: oldest }],
    );
    return true;
  }, [oldest, hasOlder, isLoadingOlder, failed]);
  const historyPagination = useMemo(
    () => ({
      hasOlder,
      isLoadingOlder,
      progressKey: oldest ? `${oldest.epoch}:${oldest.seq}` : null,
      onLoadOlder: loadOlder,
    }),
    [oldest, hasOlder, isLoadingOlder, loadOlder],
  );
  const retry = useCallback(() => {
    void failed?.refetch();
  }, [failed]);
  const origin = history
    ? (hosts.find((host) => host.serverId === history.sourceServerId)?.label ??
      history.sourceServerId)
    : "";
  return (
    <View style={styles.history} testID="handoff-history-content">
      {queries[0].isPending ? <Text style={styles.note}>{t("handoff.busy.loading")}</Text> : null}
      {history && context && historyPane ? (
        <>
          <View style={styles.origin}>
            <Text style={styles.label}>{t("handoff.historyOrigin", { host: origin })}</Text>
            <Text selectable style={styles.note}>
              {history.sourceCwd}
            </Text>
            <Text style={styles.note}>{t("handoff.historyNotice")}</Text>
          </View>
          <PaneProvider value={historyPane}>
            <AgentStreamView
              agentId={streamId}
              serverId={history.sourceServerId}
              context={context}
              streamItems={stream.tail}
              streamHead={stream.head}
              pendingPermissions={EMPTY_PERMISSIONS}
              turnPresentation={IDLE_TURN}
              historyPagination={historyPagination}
              subagentParentId={history.sourceAgentId}
              isAuthoritativeHistoryReady
              readOnly
            />
          </PaneProvider>
        </>
      ) : null}
      {failed?.error ? (
        <View style={styles.error} accessibilityRole="alert">
          <Text style={styles.note}>{failed.error.message}</Text>
          <Button
            size="sm"
            variant="outline"
            loading={failed.isFetching}
            onPress={retry}
            testID="handoff-history-retry"
          >
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

export function ConversationHandoff({ serverId, agentId }: Props) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const pane = usePaneContext();
  const paneFocus = usePaneFocus();
  const contextBridge = useCallback<ContextBridge>(
    (content) => (
      <PaneProvider value={pane}>
        <PaneFocusProvider value={paneFocus}>{content}</PaneFocusProvider>
      </PaneProvider>
    ),
    [pane, paneFocus],
  );
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const header = useMemo(() => ({ title: t("handoff.history") }), [t]);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceHandoff === true,
  );
  const mode = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.labels[
      "paseo.handoff-mode"
    ];
  });
  if (!supported || (mode !== "native" && mode !== "context")) return null;
  return (
    <>
      <View style={styles.banner} testID="handoff-provenance">
        <Text style={styles.bannerText}>
          {t(mode === "native" ? "handoff.continuedNative" : "handoff.continuedContext")}
        </Text>
        <Button size="sm" variant="ghost" onPress={show} testID="handoff-history-open">
          {t("handoff.history")}
        </Button>
      </View>
      {open && active ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={close}
          desktopMaxWidth={800}
          desktopHeight="85%"
          snapPoints={SNAP_POINTS}
          scrollable={false}
          contentStyle={styles.sheetContent}
          contextBridge={contextBridge}
          testID="handoff-history-sheet"
        >
          <HistoryContent serverId={serverId} agentId={agentId} onClose={close} />
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  bannerText: {
    flex: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  history: { flex: 1, minHeight: 0 },
  sheetContent: { flex: 1, minHeight: 0 },
  origin: { gap: theme.spacing[2], paddingBottom: theme.spacing[3] },
  label: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  note: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  error: { gap: theme.spacing[2], alignItems: "flex-start", paddingVertical: theme.spacing[3] },
}));
