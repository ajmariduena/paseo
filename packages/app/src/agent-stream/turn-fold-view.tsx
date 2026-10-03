import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Clock } from "lucide-react-native";
import { ExpandableBadge } from "@/components/message";
import { Button } from "@/components/ui/button";
import { DiffStat } from "@/components/diff-stat";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useOverviewSummary } from "@/tool-calls/detail-level/overview/view";
import { formatDuration } from "@/utils/time";
import type { TurnFileChange, TurnFold } from "./turn-fold";

const VISIBLE_FILE_ROWS = 3;

interface TurnFoldHeaderProps {
  fold: TurnFold;
  runningStartedAt: Date | null;
  isLastInSequence: boolean;
  onExpandedChange: (foldKey: string, expanded: boolean) => void;
}

export const TurnFoldHeader = memo(function TurnFoldHeader({
  fold,
  runningStartedAt,
  isLastInSequence,
  onExpandedChange,
}: TurnFoldHeaderProps) {
  if (fold.state === "running") {
    return (
      <RunningTurnFoldHeader
        startedAt={runningStartedAt ?? fold.startedAt}
        isLastInSequence={isLastInSequence}
      />
    );
  }
  return (
    <CompletedTurnFoldHeader
      fold={fold}
      isLastInSequence={isLastInSequence}
      onExpandedChange={onExpandedChange}
    />
  );
});

function useElapsedMs(startedAt: Date): number {
  const active = useRetainedPanelActive();
  const startedAtMs = startedAt.getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [active]);
  return Math.max(0, now - startedAtMs);
}

function RunningTurnFoldHeader({
  startedAt,
  isLastInSequence,
}: {
  startedAt: Date;
  isLastInSequence: boolean;
}) {
  const { t } = useTranslation();
  const elapsedMs = useElapsedMs(startedAt);
  return (
    <ExpandableBadge
      testID="turn-fold-running"
      label={t("turnFold.working")}
      secondaryLabel={formatDuration(elapsedMs)}
      icon={Clock}
      isExpanded={false}
      isLoading
      isLastInSequence={isLastInSequence}
    />
  );
}

function CompletedTurnFoldHeader({
  fold,
  isLastInSequence,
  onExpandedChange,
}: Omit<TurnFoldHeaderProps, "runningStartedAt">) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const summary = useOverviewSummary(fold.summary);
  const secondaryLabel = useMemo(() => {
    const parts: string[] = [];
    if (fold.stepCount > 0) {
      parts.push(
        t(`turnFold.steps.${fold.stepCount === 1 ? "one" : "other"}`, { count: fold.stepCount }),
      );
    }
    if (!isCompact && summary) {
      parts.push(summary);
    }
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }, [fold.stepCount, isCompact, summary, t]);
  const toggle = useCallback(
    () => onExpandedChange(fold.key, !fold.expanded),
    [fold.expanded, fold.key, onExpandedChange],
  );
  return (
    <ExpandableBadge
      testID="turn-fold-header"
      label={t("turnFold.worked", { duration: formatDuration(fold.durationMs) })}
      secondaryLabel={secondaryLabel}
      icon={Clock}
      isExpanded={fold.expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
    />
  );
}

function splitDisplayPath(path: string, cwd: string | undefined): { dir: string; name: string } {
  const root = cwd?.replace(/[\\/]+$/, "");
  const relative =
    root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
      ? path.slice(root.length + 1)
      : path;
  const separator = Math.max(relative.lastIndexOf("/"), relative.lastIndexOf("\\"));
  return { dir: relative.slice(0, separator + 1), name: relative.slice(separator + 1) };
}

interface TurnFilesCardProps {
  files: readonly TurnFileChange[];
  cwd: string | undefined;
  onOpenChanges: () => void;
  onOpenFile: (path: string) => void;
}

export const TurnFilesCard = memo(function TurnFilesCard({
  files,
  cwd,
  onOpenChanges,
  onOpenFile,
}: TurnFilesCardProps) {
  const { t } = useTranslation();
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );
  const hiddenCount = files.length - VISIBLE_FILE_ROWS;
  return (
    <View style={styles.card} testID="turn-files-card">
      <View style={styles.header}>
        <Text style={styles.headerText} numberOfLines={1}>
          {t(`turnFiles.changed.${files.length === 1 ? "one" : "other"}`, {
            count: files.length,
          })}
        </Text>
        <DiffStat additions={totals.additions} deletions={totals.deletions} />
        <View style={styles.headerSpacer} />
        <Button variant="outline" size="sm" onPress={onOpenChanges} testID="turn-files-open-diff">
          {t("turnFiles.openDiff")}
        </Button>
      </View>
      {files.slice(0, VISIBLE_FILE_ROWS).map((file) => (
        <TurnFileRow key={file.path} file={file} cwd={cwd} onOpenFile={onOpenFile} />
      ))}
      {hiddenCount > 0 ? (
        <Text style={styles.more}>{t("turnFiles.more", { count: hiddenCount })}</Text>
      ) : null}
    </View>
  );
});

function fileRowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, hovered || pressed ? styles.rowActive : null];
}

function TurnFileRow({
  file,
  cwd,
  onOpenFile,
}: {
  file: TurnFileChange;
  cwd: string | undefined;
  onOpenFile: (path: string) => void;
}) {
  const { dir, name } = splitDisplayPath(file.path, cwd);
  const handlePress = useCallback(() => onOpenFile(file.path), [file.path, onOpenFile]);
  return (
    <Pressable
      style={fileRowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={file.path}
    >
      <Text style={styles.path} numberOfLines={1}>
        {dir ? <Text style={styles.dir}>{dir}</Text> : null}
        {name}
      </Text>
      <DiffStat additions={file.additions} deletions={file.deletions} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  headerSpacer: {
    flex: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
  },
  rowActive: {
    backgroundColor: theme.colors.surface2,
  },
  path: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  dir: {
    color: theme.colors.foregroundMuted,
  },
  more: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
