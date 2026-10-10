import { useCallback, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { handoffContinuationSummary } from "@getpaseo/protocol/handoff-control";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useHosts } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { shortenPath } from "@/utils/shorten-path";
import type { HandoffFormInput } from "./form-model";
import { listIncomingHandoffs, type IncomingHandoff } from "./runtime";
import { HandoffSheet } from "./sheet";

function IncomingTransferRow({
  transfer,
  onSelect,
  disabled,
}: {
  transfer: IncomingHandoff;
  onSelect: (transfer: IncomingHandoff) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const source = hosts.find(({ serverId }) => serverId === transfer.sourceServerId);
  const select = useCallback(() => onSelect(transfer), [onSelect, transfer]);
  const label = source?.label ?? t("handoff.sourceUnavailable");
  return (
    <SettingsRow
      label={shortenPath(transfer.destinationCwd)}
      hint={`${label} · ${t(`handoff.${handoffContinuationSummary(transfer)}`)}`}
    >
      <Button
        variant="outline"
        size="sm"
        onPress={select}
        disabled={disabled}
        testID={`incoming-handoff-${transfer.transferId}`}
      >
        {t("handoff.resume")}
      </Button>
    </SettingsRow>
  );
}

export function IncomingHandoffs({
  destination,
}: {
  destination: Pick<HostProfile, "serverId" | "label">;
}) {
  const { t } = useTranslation();
  const active = useIsFocused();
  const [selection, setSelection] = useState<HandoffFormInput | null>(null);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1]!;
  const query = useFetchQuery({
    dataShape: "list",
    queryKey: ["incoming-handoffs", destination.serverId, cursor],
    enabled: active,
    staleTimeMs: 0,
    retry: false,
    queryFn: () => listIncomingHandoffs(destination.serverId, cursor),
  });
  const transfers = query.data?.transfers ?? [];
  const nextCursor = query.data?.nextCursor;
  const select = useCallback(
    (transfer: IncomingHandoff) => {
      setSelection({
        sourceServerId: transfer.sourceServerId,
        workspaceId: transfer.sourceWorkspaceId,
        recovery: {
          destination: { serverId: destination.serverId, label: destination.label },
          transferId: transfer.transferId,
        },
      });
    },
    [destination.serverId, destination.label],
  );
  const { refetch } = query;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const more = useCallback(() => {
    if (nextCursor && !query.isFetching) setCursors((previous) => [...previous, nextCursor]);
  }, [nextCursor, query.isFetching]);
  const previous = useCallback(() => {
    if (!query.isFetching) setCursors((pages) => (pages.length > 1 ? pages.slice(0, -1) : pages));
  }, [query.isFetching]);
  const close = useCallback(() => {
    setSelection(null);
    void refetch();
  }, [refetch]);
  return (
    <SettingsSection title={t("handoff.pendingTransfers")}>
      <SettingsCard testID="incoming-handoffs">
        {query.isPending ? <SettingsRow label={t("common.loading")} /> : null}
        {transfers.map((transfer) => (
          <IncomingTransferRow
            key={transfer.transferId}
            transfer={transfer}
            onSelect={select}
            disabled={query.isFetching}
          />
        ))}
        {query.isSuccess && transfers.length === 0 ? (
          <SettingsRow
            label={t(cursor ? "common.empty.noResults" : "handoff.noPendingTransfers")}
            testID="incoming-handoffs-empty"
          />
        ) : null}
        {query.isError ? (
          <SettingsRow
            label={t("common.errors.error")}
            error={query.error.message}
            testID="incoming-handoffs-error"
          >
            <Button
              variant="outline"
              size="sm"
              onPress={refresh}
              disabled={query.isFetching}
              loading={query.isFetching}
              testID="incoming-handoffs-retry"
            >
              {t("common.actions.retry")}
            </Button>
          </SettingsRow>
        ) : null}
      </SettingsCard>
      <View style={styles.pagination}>
        {cursors.length > 1 ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={previous}
            disabled={query.isFetching}
            testID="incoming-handoffs-previous"
          >
            {t("handoff.previousTransfers")}
          </Button>
        ) : null}
        {nextCursor ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={more}
            disabled={query.isFetching}
            loading={query.isFetching && query.isPlaceholderData}
            testID="incoming-handoffs-more"
          >
            {t("handoff.nextTransfers")}
          </Button>
        ) : null}
      </View>
      {selection ? <HandoffSheet {...selection} active={active} visible onClose={close} /> : null}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  pagination: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
