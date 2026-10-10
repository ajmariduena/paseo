import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { readSourceHandoffRecord } from "./runtime";

import { useSourceHandoff } from "./state";

export function SourceHandoff({
  serverId,
  workspaceId,
  active,
  onReview,
}: {
  serverId: string;
  workspaceId: string;
  active: boolean;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const handoff = useSourceHandoff(serverId, workspaceId);
  const hosts = useHosts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceHandoff === true,
  );
  const request = useRef({ active: false, busy: false });
  useEffect(() => {
    const lifecycle = { active, busy: false };
    request.current = lifecycle;
    setBusy(false);
    setError(null);
    return () => {
      lifecycle.active = false;
    };
  }, [active, handoff?.transferId, serverId, workspaceId]);
  const open = useCallback(async () => {
    const lifecycle = request.current;
    if (!lifecycle.active || lifecycle.busy || !handoff) return;
    if (handoff.state !== "released") {
      onReview();
      return;
    }
    lifecycle.busy = true;
    setBusy(true);
    setError(null);
    try {
      const record = await readSourceHandoffRecord({ sourceServerId: serverId, workspaceId });
      if (!lifecycle.active) return;
      if (!record || record.transferId !== handoff.transferId)
        throw new Error(t("handoff.sourceChanged"));
      if (record.snapshot?.state !== "active") {
        onReview();
        return;
      }
      navigateToWorkspace({
        serverId: record.destinationServerId,
        workspaceId: record.snapshot.workspaceId,
      });
    } catch (cause) {
      if (lifecycle.active)
        setError(cause instanceof Error ? cause.message : t("handoff.sourceChanged"));
    } finally {
      lifecycle.busy = false;
      if (lifecycle.active) setBusy(false);
    }
  }, [handoff, onReview, serverId, t, workspaceId]);
  if (!supported || !handoff || handoff.state === "cancelled") return null;
  const host = hosts.find((candidate) => candidate.serverId === handoff.destinationServerId);
  return (
    <View style={styles.banner} testID="handoff-source-state">
      <View style={[styles.row, isCompact && styles.compactRow]}>
        <Text
          style={[styles.text, isCompact && styles.compactText]}
          accessibilityLiveRegion="polite"
        >
          {t(handoff.state === "released" ? "handoff.sourceReleased" : "handoff.sourceHeld", {
            host: host?.label ?? handoff.destinationServerId,
          })}
        </Text>
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          disabled={busy}
          onPress={open}
          testID="handoff-source-open"
          style={isCompact ? styles.compactAction : undefined}
        >
          {t(
            handoff.state === "released" ? "handoff.continueDestination" : "handoff.reviewTransfer",
          )}
        </Button>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="handoff-source-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  text: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  compactRow: { flexDirection: "column", alignItems: "stretch" },
  compactText: { flex: 0 },
  compactAction: { alignSelf: "flex-start", marginLeft: -theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
