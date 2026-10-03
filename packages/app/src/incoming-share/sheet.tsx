import { useCallback, useMemo, useReducer, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronRight, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useProjects } from "@/hooks/use-projects";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { getHostRuntimeStore, useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { orderHostsLocalFirst, type HostProfile } from "@/types/host-connection";
import {
  deliverIncomingShare,
  IncomingShareHostDisconnectedError,
  type IncomingShareTarget,
} from "./deliver";
import {
  buildShareAgentOptions,
  buildShareWorkspaceOptions,
  type ShareAgentOption,
  type ShareWorkspaceOption,
} from "./destinations";
import type { IncomingShare } from "./model";
import {
  canGoBack,
  createIncomingShareSheetState,
  reduceIncomingShareSheet,
  type IncomingShareDelivery,
} from "./sheet-state";
import { useIncomingShareStore, type PendingIncomingShare } from "./store";

const ThemedChevronRight = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedPlus = withUnistyles(Plus, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

const SHARE_SHEET_SNAP_POINTS = ["70%", "92%"];
const NEW_AGENT_TARGET_KEY = "new-agent";
const DISABLED_STATE = { disabled: true };

function targetKeyOf(target: IncomingShareTarget): string {
  return target.kind === "agent" ? target.agentId : NEW_AGENT_TARGET_KEY;
}

function ShareRow({
  disabled,
  onPress,
  testID,
  children,
}: {
  disabled: boolean;
  onPress: () => void;
  testID: string;
  children: ReactNode;
}) {
  const rowStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
      disabled && styles.rowDisabled,
    ],
    [disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={disabled ? DISABLED_STATE : undefined}
      disabled={disabled}
      onPress={onPress}
      style={rowStyle}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

function RowText({ title, subtitle }: { title: string; subtitle: string | null }) {
  return (
    <View style={styles.rowContent}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

function HostRow({ host, onChoose }: { host: HostProfile; onChoose: (serverId: string) => void }) {
  const handlePress = useCallback(() => onChoose(host.serverId), [host.serverId, onChoose]);
  return (
    <ShareRow
      disabled={false}
      onPress={handlePress}
      testID={`incoming-share-host-${host.serverId}`}
    >
      <View style={styles.rowLeading}>
        <HostStatusDotSlot serverId={host.serverId} />
      </View>
      <RowText title={host.label} subtitle={null} />
      <ThemedChevronRight size={14} />
    </ShareRow>
  );
}

function WorkspaceRow({
  option,
  onChoose,
}: {
  option: ShareWorkspaceOption;
  onChoose: (workspaceId: string) => void;
}) {
  const handlePress = useCallback(
    () => onChoose(option.workspaceId),
    [onChoose, option.workspaceId],
  );
  return (
    <ShareRow
      disabled={false}
      onPress={handlePress}
      testID={`incoming-share-workspace-${option.workspaceId}`}
    >
      <RowText title={option.title} subtitle={option.subtitle || null} />
      <ThemedChevronRight size={14} />
    </ShareRow>
  );
}

function TargetRow({
  target,
  delivery,
  onChoose,
  children,
}: {
  target: IncomingShareTarget;
  delivery: IncomingShareDelivery;
  onChoose: (target: IncomingShareTarget) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const targetKey = targetKeyOf(target);
  const isPending = delivery.status === "pending";
  const isThisPending = isPending && delivery.targetKey === targetKey;
  const handlePress = useCallback(() => onChoose(target), [onChoose, target]);
  return (
    <ShareRow
      disabled={isPending}
      onPress={handlePress}
      testID={`incoming-share-target-${targetKey}`}
    >
      {children}
      {isThisPending ? (
        <View style={styles.pendingSlot}>
          <ThemedLoadingSpinner />
          <Text style={styles.rowSubtitle}>{t("incomingShare.adding")}</Text>
        </View>
      ) : null}
    </ShareRow>
  );
}

const NEW_AGENT_TARGET: IncomingShareTarget = { kind: "new_agent" };

function NewAgentRow({
  delivery,
  onChoose,
}: {
  delivery: IncomingShareDelivery;
  onChoose: (target: IncomingShareTarget) => void;
}) {
  const { t } = useTranslation();
  return (
    <TargetRow target={NEW_AGENT_TARGET} delivery={delivery} onChoose={onChoose}>
      <View style={styles.rowLeading}>
        <ThemedPlus size={14} />
      </View>
      <RowText title={t("incomingShare.newAgent")} subtitle={null} />
    </TargetRow>
  );
}

function AgentActivity({ date }: { date: Date }) {
  const label = useTimeAgo(date);
  return (
    <Text style={styles.rowSubtitle} numberOfLines={1}>
      {label}
    </Text>
  );
}

function AgentRow({
  option,
  delivery,
  onChoose,
}: {
  option: ShareAgentOption;
  delivery: IncomingShareDelivery;
  onChoose: (target: IncomingShareTarget) => void;
}) {
  const { t } = useTranslation();
  const target = useMemo<IncomingShareTarget>(
    () => ({ kind: "agent", agentId: option.agentId }),
    [option.agentId],
  );
  return (
    <TargetRow target={target} delivery={delivery} onChoose={onChoose}>
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {option.title || t("incomingShare.untitledAgent")}
        </Text>
        <AgentActivity date={option.lastActivityAt} />
      </View>
    </TargetRow>
  );
}

function StatusLine({ children }: { children: ReactNode }) {
  return <Text style={styles.statusText}>{children}</Text>;
}

function HostPage({ onChoose }: { onChoose: (serverId: string) => void }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  if (orderedHosts.length === 0) {
    return <StatusLine>{t("incomingShare.noHosts")}</StatusLine>;
  }
  return (
    <View style={styles.list}>
      {orderedHosts.map((host) => (
        <HostRow key={host.serverId} host={host} onChoose={onChoose} />
      ))}
    </View>
  );
}

function WorkspacePage({
  serverId,
  query,
  onChoose,
}: {
  serverId: string;
  query: string;
  onChoose: (workspaceId: string) => void;
}) {
  const { t } = useTranslation();
  const { projects, isLoading } = useProjects({ enabled: true });
  const lastSelection = useLastWorkspaceSelection();
  const lastWorkspaceId = lastSelection?.serverId === serverId ? lastSelection.workspaceId : null;
  const options = useMemo(
    () => buildShareWorkspaceOptions({ projects, serverId, query, lastWorkspaceId }),
    [lastWorkspaceId, projects, query, serverId],
  );
  if (options.length === 0) {
    return isLoading ? (
      <View style={styles.loading}>
        <ThemedLoadingSpinner />
      </View>
    ) : (
      <StatusLine>{t("incomingShare.noWorkspaces")}</StatusLine>
    );
  }
  return (
    <View style={styles.list}>
      {options.map((option) => (
        <WorkspaceRow key={option.workspaceId} option={option} onChoose={onChoose} />
      ))}
    </View>
  );
}

function AgentPage({
  serverId,
  workspaceId,
  delivery,
  onChoose,
}: {
  serverId: string;
  workspaceId: string;
  delivery: IncomingShareDelivery;
  onChoose: (target: IncomingShareTarget) => void;
}) {
  const { agents } = useAggregatedAgents({ demand: true });
  const options = useMemo(
    () => buildShareAgentOptions({ agents, serverId, workspaceId }),
    [agents, serverId, workspaceId],
  );
  return (
    <View style={styles.list}>
      <NewAgentRow delivery={delivery} onChoose={onChoose} />
      {options.map((option) => (
        <AgentRow key={option.agentId} option={option} delivery={delivery} onChoose={onChoose} />
      ))}
    </View>
  );
}

function useShareSummary(share: IncomingShare): string {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (share.text) {
    parts.push(t("incomingShare.summary.text"));
  }
  if (share.files.length > 0) {
    parts.push(t("incomingShare.summary.attachments", { count: share.files.length }));
  }
  return parts.join(" · ");
}

function IncomingShareSheetBody({
  share,
  visible,
  onClose,
}: {
  share: IncomingShare;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const [state, dispatch] = useReducer(
    reduceIncomingShareSheet,
    hosts.map((host) => host.serverId),
    createIncomingShareSheetState,
  );
  const [query, setQuery] = useState("");
  const summary = useShareSummary(share);
  const { page, delivery } = state;

  const chooseHost = useCallback((serverId: string) => {
    setQuery("");
    dispatch({ type: "chooseHost", serverId });
  }, []);
  const chooseWorkspace = useCallback((workspaceId: string) => {
    setQuery("");
    dispatch({ type: "chooseWorkspace", workspaceId });
  }, []);
  const goBack = useCallback(() => dispatch({ type: "back" }), []);

  const chooseTarget = useStableEvent(async (target: IncomingShareTarget) => {
    if (page.kind !== "agent") {
      return;
    }
    dispatch({ type: "deliveryStarted", targetKey: targetKeyOf(target) });
    try {
      await deliverIncomingShare({
        share,
        destination: { serverId: page.serverId, workspaceId: page.workspaceId, target },
        client: getHostRuntimeStore().getClient(page.serverId),
      });
      onClose();
    } catch (error) {
      if (error instanceof IncomingShareHostDisconnectedError) {
        dispatch({ type: "deliveryFailed", reason: "hostDisconnected" });
        return;
      }
      console.warn("[IncomingShare] Failed to add shared content", error);
      dispatch({ type: "deliveryFailed", reason: "failed" });
    }
  });

  const header = useMemo<SheetHeader>(
    () => ({
      title: t(`incomingShare.steps.${page.kind}`),
      subtitle: summary ? (
        <Text style={styles.headerSubtitle} numberOfLines={1}>
          {summary}
        </Text>
      ) : undefined,
      back: canGoBack({ page, hostCount: hosts.length }) ? { onPress: goBack } : undefined,
      search:
        page.kind === "workspace"
          ? {
              onChange: setQuery,
              resetKey: page.serverId,
              placeholder: t("incomingShare.searchWorkspaces"),
              testID: "incoming-share-workspace-search",
            }
          : undefined,
    }),
    [goBack, hosts.length, page, summary, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SHARE_SHEET_SNAP_POINTS}
      testID="incoming-share-sheet"
    >
      {share.droppedFileCount > 0 ? (
        <StatusLine>
          {t("incomingShare.droppedFiles", { count: share.droppedFileCount })}
        </StatusLine>
      ) : null}
      {delivery.status === "failed" ? (
        <Text style={styles.errorText}>{t(`incomingShare.errors.${delivery.reason}`)}</Text>
      ) : null}
      {page.kind === "host" ? <HostPage onChoose={chooseHost} /> : null}
      {page.kind === "workspace" ? (
        <WorkspacePage serverId={page.serverId} query={query} onChoose={chooseWorkspace} />
      ) : null}
      {page.kind === "agent" ? (
        <AgentPage
          serverId={page.serverId}
          workspaceId={page.workspaceId}
          delivery={delivery}
          onChoose={chooseTarget}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

/** Asks where a share from another app should land, then fills that composer. */
export function IncomingShareSheet() {
  const pending = useIncomingShareStore((state) => state.pending);
  const dismiss = useIncomingShareStore((state) => state.dismiss);
  const hostRegistryLoaded = useHostRegistryLoaded();
  // Keeps the last share on screen while the sheet animates closed.
  const [shown, setShown] = useState<PendingIncomingShare | null>(pending);
  if (pending && pending !== shown) {
    setShown(pending);
  }
  if (!shown || !hostRegistryLoaded) {
    return null;
  }
  return (
    <IncomingShareSheetBody
      key={shown.id}
      share={shown.share}
      visible={pending !== null}
      onClose={dismiss}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  headerSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  list: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 44,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowDisabled: {
    opacity: theme.opacity[50],
  },
  rowLeading: {
    width: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  pendingSlot: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  loading: {
    paddingVertical: theme.spacing[6],
    alignItems: "center",
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
}));
