import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { useHostAgents } from "@/host-health/data";
import { HostCard } from "@/host-health/host-card";
import { HostDetail } from "@/host-health/host-detail";
import type { ProcessSort } from "@/host-health/model";

// Two columns only once each card keeps the width the single column has.
const TWO_COLUMN_MIN_WIDTH = 1040;

export function HostHealthScreen({ serverId }: { serverId: string | null }): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return serverId ? <HostHealthDetail serverId={serverId} /> : <HostHealthOverview />;
}

function HostHealthDetail({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const host = useHosts().find((candidate) => candidate.serverId === serverId);
  return (
    <View style={styles.container}>
      <BackHeader title={compact && host ? host.label : t("hostHealth.title")} />
      {host ? (
        <HostDetail serverId={serverId} label={host.label} compact={compact} />
      ) : (
        <View style={styles.centered}>
          <Text style={styles.message}>{t("hostHealth.hostNotFound")}</Text>
        </View>
      )}
    </View>
  );
}

function HostHealthOverview(): ReactElement {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const agents = useHostAgents();
  const [sort, setSort] = useState<ProcessSort>("cpu");
  const [width, setWidth] = useState(0);
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const online = serverIds.filter((serverId) => statuses.get(serverId) === "online").length;
  const twoColumns = !compact && hosts.length > 1 && width >= TWO_COLUMN_MIN_WIDTH;

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const sortOptions = useMemo(
    () => [
      { value: "cpu" as const, label: t("hostHealth.sortCpu") },
      { value: "memory" as const, label: t("hostHealth.sortMemory") },
    ],
    [t],
  );
  const sortControl = useMemo(
    () => (
      <SegmentedControl
        size="xs"
        value={sort}
        onValueChange={setSort}
        options={sortOptions}
        testID="host-health-sort"
      />
    ),
    [sort, sortOptions],
  );
  const headerRight = useMemo(
    () => (
      <View style={styles.headerRight}>
        {compact ? null : sortControl}
        <View style={styles.live}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>{t("hostHealth.live")}</Text>
        </View>
      </View>
    ),
    [compact, sortControl, t],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("hostHealth.title")} rightContent={headerRight} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        onLayout={handleLayout}
        testID="host-health-overview"
      >
        <View style={[styles.column, twoColumns ? styles.columnWide : null]}>
          {compact ? <View style={styles.compactToolbar}>{sortControl}</View> : null}
          {hosts.length === 0 ? (
            <Text style={styles.message}>{t("hostHealth.noHosts")}</Text>
          ) : (
            <View style={twoColumns ? styles.grid : styles.stack}>
              {hosts.map((host) => (
                <View key={host.serverId} style={twoColumns ? styles.gridCell : null}>
                  <HostCard
                    serverId={host.serverId}
                    label={host.label}
                    sort={sort}
                    compact={compact}
                    agents={agents}
                  />
                </View>
              ))}
            </View>
          )}
          {hosts.length > 0 ? (
            <Text style={styles.footer}>
              {t("hostHealth.summary", { online, total: hosts.length })}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  live: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDotSuccess,
  },
  liveText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
  },
  column: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  columnWide: {
    maxWidth: 1456,
  },
  compactToolbar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: theme.spacing[3],
  },
  stack: {
    gap: theme.spacing[4],
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
  },
  gridCell: {
    flexBasis: "45%",
    flexGrow: 1,
  },
  footer: {
    marginTop: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
