import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Archive, Check, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useProviderIcons, type ProviderIconComponent } from "@/components/provider-icons";
import {
  MenuHint,
  MenuLabel,
  MenuSeparator,
  MenuSurface,
  useMenuContext,
} from "@/components/ui/menu";
import { ComposerTrackRow } from "@/composer/tracks";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { Theme } from "@/styles/theme";
import { formatSubagentStatusWord } from "@/subagents/presentation/status";
import { useElapsedNow } from "@/subagents/presentation/use-elapsed-now";
import type { SubagentOpenTarget } from "@/subagents/timeline/model";
import type { OpenSubagentActions } from "@/subagents/use-open-subagent";
import { formatDuration } from "@/utils/time";
import {
  LINEAGE_PAGE_SIZE,
  pageLineageRows,
  type LineageParent,
  type LineageRow,
  type LineageSections,
} from "./model";
import { useLineage, type ArchivedLineageState } from "./use-lineage";

const ThemedArchive = withUnistyles(Archive);
const ThemedCheck = withUnistyles(Check);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ROW_ICON_SIZE = 14;
const LINEAGE_MIN_WIDTH = 280;
const LINEAGE_MAX_WIDTH = 420;

export function formatLineageTitle(t: TFunction, sections: LineageSections): string {
  return sections.runningCount > 0
    ? t("lineage.titleRunning", { count: sections.runningCount })
    : t("lineage.title");
}

function iconPresentation(input: {
  key: string;
  label: string;
  icon: ProviderIconComponent;
  statusBucket: WorkspaceTabPresentation["statusBucket"];
}): WorkspaceTabPresentation {
  return {
    key: input.key,
    kind: "agent",
    label: input.label,
    subtitle: "",
    tooltip: input.label,
    modified: false,
    showCloseButton: false,
    titleState: "ready",
    icon: input.icon,
    statusBucket: input.statusBucket,
  };
}

function LineageRowTrailing({ row }: { row: LineageRow }): ReactElement {
  const { t } = useTranslation();
  const now = useElapsedNow(row.liveSince !== null);
  const word = formatSubagentStatusWord(t, row.status.word);
  let durationMs = row.settledDurationMs;
  if (row.liveSince) durationMs = Math.max(0, now - row.liveSince.getTime());
  return (
    <Text style={styles.trailing} numberOfLines={1}>
      {durationMs === null ? word : `${word} · ${formatDuration(durationMs)}`}
    </Text>
  );
}

function LineageChildRow({
  row,
  icon,
  onOpen,
}: {
  row: LineageRow;
  icon: ProviderIconComponent;
  onOpen: (target: SubagentOpenTarget) => void;
}): ReactElement {
  const { t } = useTranslation();
  const label = row.title ?? t("subagents.untitled");
  const handlePress = useCallback(() => onOpen(row.target), [onOpen, row.target]);
  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <WorkspaceTabIcon
          presentation={iconPresentation({
            key: row.key,
            label,
            icon,
            statusBucket: row.status.bucket,
          })}
          backdrop={active ? "surface2" : "surface1"}
        />
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <LineageRowTrailing row={row} />
        <ThemedChevronRight size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />
      </>
    ),
    [icon, label, row],
  );
  return (
    <ComposerTrackRow
      accessibilityLabel={t("subagents.openAction", { label })}
      testID={`lineage-row-${row.key}`}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function LineageParentRow({
  parent,
  icon,
  onOpen,
}: {
  parent: LineageParent;
  icon: ProviderIconComponent;
  onOpen: (agentId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const label = parent.title ?? t("lineage.parentFallback");
  const handlePress = useCallback(() => onOpen(parent.id), [onOpen, parent.id]);
  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <WorkspaceTabIcon
          presentation={iconPresentation({
            key: parent.id,
            label,
            icon,
            statusBucket: parent.status.bucket,
          })}
          backdrop={active ? "surface2" : "surface1"}
        />
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        {parent.modelLabel ? (
          <Text style={styles.trailing} numberOfLines={1}>
            {parent.modelLabel}
          </Text>
        ) : null}
        <ThemedChevronRight size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />
      </>
    ),
    [icon, label, parent],
  );
  return (
    <ComposerTrackRow
      accessibilityLabel={t("subagents.openAction", { label })}
      testID="lineage-row-parent"
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function ShowMoreRow({ count, onPress }: { count: number; onPress: () => void }): ReactElement {
  const { t } = useTranslation();
  const label = t("lineage.showMore", { count });
  return (
    <ComposerTrackRow accessibilityLabel={label} closeOnSelect={false} onPress={onPress}>
      <View style={styles.iconSpacer} />
      <Text style={styles.mutedLabel} numberOfLines={1}>
        {label}
      </Text>
    </ComposerTrackRow>
  );
}

function PagedRows({
  rows,
  resolveIcon,
  onOpen,
}: {
  rows: readonly LineageRow[];
  resolveIcon: (provider: string) => ProviderIconComponent;
  onOpen: (target: SubagentOpenTarget) => void;
}): ReactElement {
  const [limit, setLimit] = useState(LINEAGE_PAGE_SIZE);
  const page = pageLineageRows(rows, limit);
  const showMore = useCallback(() => setLimit((current) => current + page.nextCount), [page]);
  return (
    <>
      {page.visible.map((row) => (
        <LineageChildRow key={row.key} row={row} icon={resolveIcon(row.provider)} onOpen={onOpen} />
      ))}
      {page.nextCount > 0 ? <ShowMoreRow count={page.nextCount} onPress={showMore} /> : null}
    </>
  );
}

function PreviousSubagentsRow({
  count,
  failedCount,
  open,
  onToggle,
}: {
  count: number;
  failedCount: number;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const label = t("lineage.previous", { count });
  return (
    <ComposerTrackRow
      accessibilityLabel={label}
      testID="lineage-previous-toggle"
      closeOnSelect={false}
      onPress={onToggle}
    >
      <View style={open ? styles.chevronOpen : styles.chevronClosed}>
        <ThemedChevronRight size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />
      </View>
      <Text style={styles.mutedLabel} numberOfLines={1}>
        {label}
      </Text>
      {failedCount > 0 ? (
        <Text style={styles.trailing} numberOfLines={1}>
          {t("subagents.pillLabelFailed", { count: failedCount })}
        </Text>
      ) : null}
    </ComposerTrackRow>
  );
}

function IncludeArchivedRow({
  state,
  onToggle,
}: {
  state: ArchivedLineageState;
  onToggle: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const label = t("lineage.includeArchived");
  const handlePress = state.kind === "failed" ? state.retry : onToggle;
  return (
    <ComposerTrackRow
      accessibilityLabel={label}
      testID="lineage-include-archived"
      closeOnSelect={false}
      disabled={state.kind === "loading"}
      onPress={handlePress}
    >
      <ThemedArchive size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />
      <Text style={styles.mutedLabel} numberOfLines={1}>
        {label}
      </Text>
      {state.kind === "loading" ? (
        <Text style={styles.trailing}>{t("common.states.loading")}</Text>
      ) : null}
      {state.kind === "failed" ? (
        <Text style={styles.trailingError} numberOfLines={1}>
          {t("lineage.archivedLoadFailed")}
        </Text>
      ) : null}
      {state.kind === "loaded" ? (
        <ThemedCheck size={ROW_ICON_SIZE} uniProps={foregroundColorMapping} />
      ) : null}
    </ComposerTrackRow>
  );
}

interface LineageMenuState {
  sections: LineageSections;
  archived: ArchivedLineageState;
  previousOpen: boolean;
  togglePrevious: () => void;
  toggleArchived: () => void;
}

function useLineageMenuState(serverId: string, agentId: string): LineageMenuState {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [previousOpen, setPreviousOpen] = useState(false);
  const { sections, archived } = useLineage({ serverId, agentId, includeArchived });
  const togglePrevious = useCallback(() => setPreviousOpen((open) => !open), []);
  const toggleArchived = useCallback(() => {
    setIncludeArchived((current) => !current);
    setPreviousOpen(true);
  }, []);
  return { sections, archived, previousOpen, togglePrevious, toggleArchived };
}

export interface LineageMenuProps {
  serverId: string;
  agentId: string;
  actions: OpenSubagentActions;
}

/** Lineage as a submenu page of another menu. */
export function LineageMenuContent({ serverId, agentId, actions }: LineageMenuProps): ReactElement {
  const state = useLineageMenuState(serverId, agentId);
  return <LineageMenuRows serverId={serverId} state={state} actions={actions} />;
}

function OpenLineageMenuSurface({ serverId, agentId, actions }: LineageMenuProps): ReactElement {
  const { t } = useTranslation();
  const state = useLineageMenuState(serverId, agentId);
  return (
    <MenuSurface
      side="bottom"
      align="start"
      minWidth={LINEAGE_MIN_WIDTH}
      maxWidth={LINEAGE_MAX_WIDTH}
      scrollable
      sheetTitle={formatLineageTitle(t, state.sections)}
      testID="lineage-surface"
    >
      <LineageMenuRows serverId={serverId} state={state} actions={actions} />
    </MenuSurface>
  );
}

/**
 * Lineage as its own surface beside a trigger in the same menu root: a popover anchored to the
 * trigger on wide screens, a sheet on compact ones. It reads its data only while open.
 */
export function LineageMenuSurface(props: LineageMenuProps): ReactElement | null {
  const { open } = useMenuContext("LineageMenuSurface");
  return open ? <OpenLineageMenuSurface {...props} /> : null;
}

/** An agent session's parent and subagents, as rows on a menu surface. */
function LineageMenuRows({
  serverId,
  state,
  actions,
}: {
  serverId: string;
  state: LineageMenuState;
  actions: OpenSubagentActions;
}): ReactElement {
  const { t } = useTranslation();
  const { presentation } = useMenuContext("LineageMenuRows");
  const resolveIcon = useProviderIcons(serverId);
  const { sections, archived, previousOpen, togglePrevious, toggleArchived } = state;
  const { openSubagent, openProviderSubagent, openParent } = actions;
  const openChild = useCallback(
    (target: SubagentOpenTarget) => {
      if (target.kind === "agent") openSubagent(target.agentId);
      else openProviderSubagent(target.parentAgentId, target.subagentId);
    },
    [openProviderSubagent, openSubagent],
  );
  const isEmpty =
    !sections.parent && sections.subagents.length === 0 && sections.previous.length === 0;

  return (
    <>
      {presentation === "popover" ? (
        <Text style={styles.title} testID="lineage-title">
          {formatLineageTitle(t, sections)}
        </Text>
      ) : null}
      {sections.parent ? (
        <>
          <MenuLabel>{t("lineage.parent")}</MenuLabel>
          <LineageParentRow
            parent={sections.parent}
            icon={resolveIcon(sections.parent.provider)}
            onOpen={openParent}
          />
        </>
      ) : null}
      {sections.subagents.length > 0 ? (
        <>
          <MenuLabel>{t("subagents.title")}</MenuLabel>
          <PagedRows rows={sections.subagents} resolveIcon={resolveIcon} onOpen={openChild} />
        </>
      ) : null}
      {isEmpty ? <MenuHint>{t("lineage.empty")}</MenuHint> : null}
      <MenuSeparator />
      {sections.previous.length > 0 ? (
        <PreviousSubagentsRow
          count={sections.previous.length}
          failedCount={sections.previousFailedCount}
          open={previousOpen}
          onToggle={togglePrevious}
        />
      ) : null}
      {previousOpen ? (
        <PagedRows rows={sections.previous} resolveIcon={resolveIcon} onOpen={openChild} />
      ) : null}
      <IncludeArchivedRow state={archived} onToggle={toggleArchived} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  title: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  label: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  mutedLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  trailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  trailingError: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[300],
  },
  iconSpacer: {
    width: ROW_ICON_SIZE,
  },
  chevronClosed: {
    transform: [{ rotate: "0deg" }],
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
}));
