import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import type { ProviderIconComponent } from "@/components/provider-icons";
import { useProviderIcons } from "@/components/provider-icons";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { useSessionStore } from "@/stores/session-store";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import type { Theme } from "@/styles/theme";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { formatDuration } from "@/utils/time";
import { selectSubagentExcerpt } from "../presentation/excerpt";
import { formatSubagentStatusWord } from "../presentation/status";
import { useElapsedNow } from "../presentation/use-elapsed-now";
import { providerSubagentKey, useProviderSubagentStore } from "../provider-store";
import { useSubagentTimeline } from "./context";
import { resolveSpawnRow, type SpawnedAgentSnapshot, type SpawnRowModel } from "./model";
import { readSubagentSpawnCall, type SubagentSpawnCall } from "./spawn-call";

const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ROW_ICON_SIZE = 14;
// Matches the tool-call row's icon slot, so subagent titles share the tool labels' rail.
const ICON_SLOT_SIZE = 22;
const EMPTY_ITEMS: readonly StreamItem[] = [];

interface ChildStreamParts {
  tail: readonly StreamItem[];
  head: readonly StreamItem[];
}

const EMPTY_PARTS: ChildStreamParts = { tail: EMPTY_ITEMS, head: EMPTY_ITEMS };

/**
 * Row models for a run of spawn calls. The run selects its children once, so a group of rows is
 * one store subscription rather than one per row.
 */
export function useSpawnRows(calls: readonly ToolCallItem[]): SpawnRowModel[] {
  const { serverId, providerSubagentsByCallId, providerEntries } = useSubagentTimeline();
  const spawns = useMemo(
    () =>
      calls.flatMap((call): SubagentSpawnCall[] => {
        const spawn = readSubagentSpawnCall(call);
        return spawn ? [spawn] : [];
      }),
    [calls],
  );
  const agents = useSessionStore(
    useShallow((state): (SpawnedAgentSnapshot | null)[] => {
      const session = state.sessions[serverId];
      return spawns.map((spawn) => {
        if (spawn.kind !== "paseo" || !spawn.agentId) return null;
        return (
          session?.agents.get(spawn.agentId) ?? session?.agentDetails.get(spawn.agentId) ?? null
        );
      });
    }),
  );
  return useMemo(
    () =>
      spawns.map((spawn, index) =>
        resolveSpawnRow({
          spawn,
          agent: agents[index] ?? null,
          descriptor: providerSubagentsByCallId.get(spawn.callId) ?? null,
          providerEntries,
        }),
      ),
    [agents, providerEntries, providerSubagentsByCallId, spawns],
  );
}

function SpawnRowStatusText({ row }: { row: SpawnRowModel }): ReactElement {
  const { t } = useTranslation();
  const now = useElapsedNow(row.liveSince !== null);
  const word = formatSubagentStatusWord(t, row.status.word);
  let durationMs: number | null = row.settledDurationMs;
  if (row.liveSince) durationMs = Math.max(0, now - row.liveSince.getTime());
  return (
    <Text style={styles.status} numberOfLines={1}>
      {durationMs === null ? word : `${word} · ${formatDuration(durationMs)}`}
    </Text>
  );
}

function useChildStreamItems(row: SpawnRowModel): readonly StreamItem[] {
  const { serverId } = useSubagentTimeline();
  const target = row.target;
  const paseoParts = useSessionStore(
    useShallow((state): ChildStreamParts => {
      if (target?.kind !== "agent") return EMPTY_PARTS;
      const session = state.sessions[serverId];
      return {
        tail: session?.agentStreamTail.get(target.agentId) ?? EMPTY_ITEMS,
        head: session?.agentStreamHead.get(target.agentId) ?? EMPTY_ITEMS,
      };
    }),
  );
  const providerParts = useProviderSubagentStore(
    useShallow((state): ChildStreamParts => {
      if (target?.kind !== "provider_subagent") return EMPTY_PARTS;
      const timeline = state.timelines.get(
        providerSubagentKey(serverId, target.parentAgentId, target.subagentId),
      );
      return { tail: timeline?.tail ?? EMPTY_ITEMS, head: timeline?.head ?? EMPTY_ITEMS };
    }),
  );
  const parts = target?.kind === "agent" ? paseoParts : providerParts;
  return useMemo(() => [...parts.tail, ...parts.head], [parts.head, parts.tail]);
}

/** Only loaded when the child's timeline already is: an open tab, or a provider pane. */
function SpawnRowExcerpt({ row }: { row: SpawnRowModel }): ReactElement | null {
  const items = useChildStreamItems(row);
  const excerpt = useMemo(
    () => selectSubagentExcerpt({ items, isLive: row.status.isLive }),
    [items, row.status.isLive],
  );
  if (!excerpt) return null;
  return (
    <Text
      style={row.status.word === "failed" ? styles.excerptFailed : styles.excerpt}
      numberOfLines={2}
    >
      {excerpt}
    </Text>
  );
}

function buildIconPresentation(input: {
  row: SpawnRowModel;
  title: string;
  icon: ProviderIconComponent;
}): WorkspaceTabPresentation {
  return {
    key: input.row.key,
    kind: "agent",
    label: input.title,
    subtitle: "",
    tooltip: input.title,
    modified: false,
    showCloseButton: false,
    titleState: "ready",
    icon: input.icon,
    statusBucket: input.row.status.bucket,
  };
}

export interface SpawnRowViewProps {
  row: SpawnRowModel;
  icon: ProviderIconComponent;
  variant: "single" | "grouped";
  onOpen: (row: SpawnRowModel) => void;
}

export const SpawnRowView = memo(function SpawnRowView({
  row,
  icon,
  variant,
  onOpen,
}: SpawnRowViewProps): ReactElement {
  const { t } = useTranslation();
  const title = row.title ?? t("subagents.untitled");
  const isOpenable = row.target !== null;
  const handlePress = useCallback(() => onOpen(row), [onOpen, row]);
  const restingBackdrop: SurfaceBackdrop = variant === "single" ? "surface0" : "surface1";
  const hoveredBackdrop: SurfaceBackdrop = variant === "single" ? "surface1" : "surface2";
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => {
      const isActive = isOpenable && (hovered || pressed);
      if (variant === "single") {
        return [styles.singleRow, isActive ? styles.singleRowActive : null];
      }
      return [styles.groupedRow, isActive ? styles.groupedRowActive : null];
    },
    [isOpenable, variant],
  );
  const accessibilityState = useMemo(() => ({ disabled: !isOpenable }), [isOpenable]);
  const restingPresentation = useMemo(
    () => buildIconPresentation({ row, title, icon }),
    [icon, row, title],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("subagents.openAction", { label: title })}
      accessibilityState={accessibilityState}
      disabled={!isOpenable}
      onPress={handlePress}
      style={pressableStyle}
      testID={`subagent-spawn-row-${row.key}`}
    >
      {({ hovered, pressed }: PressableStateCallbackType) => (
        <>
          <View style={styles.headline}>
            <View style={styles.iconSlot}>
              <WorkspaceTabIcon
                presentation={restingPresentation}
                size={ROW_ICON_SIZE}
                backdrop={isOpenable && (hovered || pressed) ? hoveredBackdrop : restingBackdrop}
              />
            </View>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <SpawnRowStatusText row={row} />
            {isOpenable ? (
              <ThemedChevronRight size={ROW_ICON_SIZE} uniProps={chevronColorMapping} />
            ) : null}
          </View>
          {variant === "grouped" ? (
            <View style={styles.details}>
              {row.modelLabel ? (
                <Text style={styles.modelLabel} numberOfLines={1}>
                  {row.modelLabel}
                </Text>
              ) : null}
              <SpawnRowExcerpt row={row} />
            </View>
          ) : null}
        </>
      )}
    </Pressable>
  );
});

/** A lone spawn call: one row at the height of a tool call. */
export const SubagentSpawnRow = memo(function SubagentSpawnRow({
  call,
}: {
  call: ToolCallItem;
}): ReactElement | null {
  const { serverId, open } = useSubagentTimeline();
  const calls = useMemo(() => [call], [call]);
  const [row] = useSpawnRows(calls);
  const resolveIcon = useProviderIcons(serverId);
  const handleOpen = useCallback(
    (target: SpawnRowModel) => {
      if (target.target) open(target.target);
    },
    [open],
  );
  if (!row) return null;
  return (
    <SpawnRowView
      row={row}
      icon={resolveIcon(row.provider ?? "")}
      variant="single"
      onOpen={handleOpen}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  singleRow: {
    marginHorizontal: -13,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
  },
  singleRowActive: {
    backgroundColor: theme.colors.surface1,
  },
  groupedRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  groupedRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  headline: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: ICON_SLOT_SIZE,
  },
  iconSlot: {
    width: ICON_SLOT_SIZE,
    height: ICON_SLOT_SIZE,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[1],
  },
  title: {
    flexShrink: 1,
    flexGrow: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  status: {
    flexShrink: 0,
    marginLeft: theme.spacing[2],
    marginRight: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  details: {
    paddingLeft: ICON_SLOT_SIZE + theme.spacing[1],
    paddingTop: theme.spacing[0.5],
    gap: theme.spacing[1],
  },
  modelLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  excerpt: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
  },
  excerptFailed: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
  },
}));
