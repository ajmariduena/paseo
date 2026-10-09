import { useSourceHandoffReadOnly } from "@/handoff/state";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ScrollView as RNScrollView, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore, type ExplorerFile } from "@/stores/session-store";
import { filePreviewRenderKind } from "@/components/file-pane-render-mode";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { getFileNameFromPath } from "@/attachments/utils";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { isFileQueryEnabled } from "@/components/file-pane-enabled";
import { isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import { useLiveFile } from "./live-file/hook";
import { useFilePreview } from "./preview-lifecycle/hook";
import { resolveFilePreviewLifecycle } from "./preview-lifecycle/model";
import { FilePanelBar } from "./bar";
import { FileHtmlPreview } from "./html-preview";
import { FileMarkdownPreview } from "./markdown-preview";
import { FileEditorModel, getFileConflictCallout, type FileConflictCallout } from "./editor/model";
import { createFileObservationSource } from "./editor/observation-source";
import { FileEditorView } from "./editor/view";
import { workspaceFileEditors } from "./editor/registry";
import { useFileEditorDraft } from "./editor/use-draft";
import type { FileEditorDraft } from "./editor/drafts";
import { FileSourceView } from "./source/view";
import type { FileConflictAlertState } from "./conflict-alert";
import type { LiveFileModel } from "./live-file/model";
import { confirmDialog } from "@/utils/confirm-dialog";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import type { Theme } from "@/styles/theme";
import { ZoomableImage } from "@/components/zoomable-viewport/image";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface FilePreviewBodyProps {
  preview: ExplorerFile | null;
  mode?: "preview" | "source";
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  imagePreviewUri: string | null;
}

type TextExplorerFile = ExplorerFile & { kind: "text" };

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ReadonlySource({
  preview,
  filename,
  location,
  navigationRevision,
}: {
  preview: ExplorerFile;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const theme = UnistylesRuntime.getTheme();
  const { t } = useTranslation();
  const visualTheme = useMemo(
    () => ({
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [theme],
  );
  return (
    <FileSourceView
      content={preview.content ?? ""}
      filename={filename}
      location={location}
      navigationRevision={navigationRevision}
      size={preview.size}
      theme={visualTheme}
      tooLargeMessage={t("panels.file.tooLargeToDisplay")}
    />
  );
}

function TooLargeSource({ size }: { size?: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="file-source-too-large">
      <Text style={styles.emptyText}>{t("panels.file.tooLargeToDisplay")}</Text>
      {size ? <Text style={styles.binaryMetaText}>{formatFileSize({ size })}</Text> : null}
    </View>
  );
}

function FilePreviewBody({
  preview,
  mode,
  isLoading,
  isMobile: _isMobile,
  location,
  navigationRevision,
  imagePreviewUri,
}: FilePreviewBodyProps) {
  const { t } = useTranslation();
  const filePath = location.path;
  // A line target means the caller wants to land on that line, so fall back to
  // the highlighted source view even for renderable files.
  const renderKind =
    preview?.kind === "text" && !location.lineStart && mode !== "source"
      ? filePreviewRenderKind(filePath)
      : null;

  const previewScrollRef = useRef<RNScrollView>(null);

  if (isLoading && !preview) {
    return (
      <View style={styles.centerState} testID="file-preview-loading">
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.loadingText}>{t("panels.file.loading")}</Text>
      </View>
    );
  }

  if (!preview) {
    return (
      <View style={styles.centerState} testID="file-preview-unsupported">
        <Text style={styles.emptyText}>{t("panels.file.noPreview")}</Text>
      </View>
    );
  }

  if (preview.kind === "text") {
    if (renderKind === "html") {
      // The HTML document owns its own scrolling, so no ScrollView wrapper here.
      return (
        <View style={styles.previewScrollContainer}>
          <FileHtmlPreview html={preview.content ?? ""} testID="file-html-preview" />
        </View>
      );
    }

    if (renderKind === "markdown") {
      return (
        <View style={styles.previewScrollContainer}>
          <RNScrollView
            ref={previewScrollRef}
            style={styles.previewContent}
            showsVerticalScrollIndicator
          >
            <FileMarkdownPreview source={preview.content ?? ""} />
          </RNScrollView>
        </View>
      );
    }

    return (
      <ReadonlySource
        preview={preview}
        filename={filePath}
        location={location}
        navigationRevision={navigationRevision}
      />
    );
  }

  if (preview.kind === "image") {
    if (!imagePreviewUri) {
      return (
        <View style={styles.centerState}>
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          <Text style={styles.loadingText}>{t("panels.file.loading")}</Text>
        </View>
      );
    }

    return <ZoomableImage uri={imagePreviewUri} testID="image-file-preview" />;
  }

  return (
    <View style={styles.centerState}>
      <Text style={styles.emptyText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
      <Text style={styles.binaryMetaText}>{formatFileSize({ size: preview.size })}</Text>
    </View>
  );
}

function recoveryPreview(draft: FileEditorDraft): ExplorerFile {
  return {
    ...draft.base.version,
    kind: "text",
    encoding: "utf-8",
    content: draft.base.content,
    hasBom: draft.base.hasBom,
    mimeType: "text/plain",
  };
}

function chooseRecoveryPreview(disk: ExplorerFile | null, recovered: ExplorerFile | null) {
  return disk?.kind === "text" ? disk : (recovered ?? disk);
}

function canEditPreview(
  preview: ExplorerFile | null,
  supportsEditing: boolean,
  draft: FileEditorDraft | null,
) {
  return (isWeb && draft !== null) || isEditableTextFile({ preview, supportsEditing });
}

function FileRecoveryGate({
  recovery,
  children,
}: {
  recovery: ReturnType<typeof useFileEditorDraft>;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { refetch } = recovery.query;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (!recovery.enabled || (!recovery.query.isPending && !recovery.query.isError)) return children;
  return (
    <View style={styles.container} testID="workspace-file-pane">
      <View style={styles.centerState}>
        {recovery.query.isError ? (
          <>
            <Text style={styles.errorText} accessibilityRole="alert">
              {t("panels.file.editor.recoveryLoadError")}
            </Text>
            <Button variant="outline" onPress={retry} loading={recovery.query.isFetching}>
              {t("common.actions.retry")}
            </Button>
          </>
        ) : (
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        )}
      </View>
    </View>
  );
}

export function FilePane({
  serverId,
  workspaceId,
  workspaceRoot,
  location,
  navigationRevision,
}: {
  serverId: string;
  workspaceId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const readOnly = useSourceHandoffReadOnly(serverId, workspaceId);
  const [previewMode, setPreviewMode] = useState<"preview" | "source">("preview");

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
  const supportsEditing = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceFileEditing === true,
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const normalizedFilePath = useMemo(() => trimNonEmpty(location.path), [location.path]);
  const readTarget = useMemo(
    () =>
      normalizedFilePath
        ? resolveFilePreviewReadTarget({
            path: normalizedFilePath,
            workspaceRoot: normalizedWorkspaceRoot,
          })
        : null,
    [normalizedFilePath, normalizedWorkspaceRoot],
  );

  const recovery = useFileEditorDraft(readTarget);

  // Re-read the file when this pane becomes visible again (#445). `isActive`
  // covers tab switches; active app visibility covers backgrounding and returning
  // from another window after an external edit. The gate lives in isFileQueryEnabled.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const enabled = isFileQueryEnabled({
    hasReadTarget: Boolean(client && readTarget),
    isTabActive: isActive,
    isAppVisible,
  });
  const liveFile = useLiveFile({
    client,
    cwd: readTarget?.cwd ?? null,
    path: readTarget?.path ?? null,
    enabled,
    liveUpdates: supportsEditing,
  });

  const targetKey = readTarget ? `${readTarget.cwd}:${readTarget.path}` : null;
  const previewLifecycle = useFilePreview({
    targetKey,
    liveFileSnapshot: liveFile.snapshot,
  });

  useEffect(() => setPreviewMode("preview"), [targetKey]);

  const { file: diskPreview, imageAttachment } = resolveFilePreviewLifecycle(previewLifecycle);
  const recoveredPreview = useMemo<ExplorerFile | null>(() => {
    if (!recovery.draft) return null;
    return recoveryPreview(recovery.draft);
  }, [recovery.draft]);
  const preview = chooseRecoveryPreview(diskPreview, recoveredPreview);
  const imagePreviewUri = useAttachmentPreviewUrl(imageAttachment);
  const isRenderable = isRenderablePreview(preview, location.path);
  const editable = canEditPreview(preview, supportsEditing, recovery.draft);
  const canTogglePreviewMode = isRenderable && !location.lineStart;
  const lineCount =
    preview?.kind === "text" ? (preview.content ?? "").split("\n").length : undefined;
  const errorMessage = previewLifecycle.status === "error" ? previewLifecycle.message : null;
  const isLoading =
    previewLifecycle.status === "initial" ||
    previewLifecycle.status === "read_pending" ||
    previewLifecycle.status === "preparing";

  return (
    <FileRecoveryGate recovery={recovery}>
      <FilePanePresentation
        serverId={serverId}
        workspaceId={workspaceId}
        client={client}
        readTarget={readTarget}
        preview={preview}
        liveFile={liveFile.model}
        onRetryRead={liveFile.refresh}
        retryingRead={liveFile.isRetrying}
        retryLabel={t("common.actions.retry")}
        filename={getFileNameFromPath(location.path) ?? location.path}
        previewMode={canTogglePreviewMode ? previewMode : undefined}
        onPreviewModeChange={canTogglePreviewMode ? setPreviewMode : undefined}
        lineCount={lineCount}
        editable={editable}
        readOnly={readOnly || !supportsEditing}
        draft={recovery.draft}
        persistDraft={recovery.persistDraft}
        disconnectedMessage={t("workspace.terminal.hostDisconnected")}
        errorMessage={errorMessage}
        isLoading={isLoading}
        isMobile={isMobile}
        location={location}
        navigationRevision={navigationRevision}
        imagePreviewUri={imagePreviewUri}
      />
    </FileRecoveryGate>
  );
}

function isRenderablePreview(preview: ExplorerFile | null, path: string): boolean {
  return preview?.kind === "text" && filePreviewRenderKind(path) !== null;
}

function isEditableTextFile(input: {
  preview: ExplorerFile | null;
  supportsEditing: boolean;
}): boolean {
  return Boolean(
    isWeb &&
    input.supportsEditing &&
    input.preview?.kind === "text" &&
    input.preview.size <= 1024 * 1024,
  );
}

function FilePanePresentation({
  serverId,
  workspaceId,
  client,
  readTarget,
  preview,
  liveFile,
  onRetryRead,
  retryingRead,
  retryLabel,
  filename,
  previewMode,
  onPreviewModeChange,
  lineCount,
  editable,
  readOnly,
  draft,
  persistDraft,
  disconnectedMessage,
  errorMessage,
  isLoading,
  isMobile,
  location,
  navigationRevision,
  imagePreviewUri,
}: {
  serverId: string;
  workspaceId: string;
  client: DaemonClient | null;
  readTarget: { cwd: string; path: string } | null;
  preview: ExplorerFile | null;
  liveFile: LiveFileModel;
  onRetryRead: () => void;
  retryingRead: boolean;
  retryLabel: string;
  filename: string;
  previewMode?: "preview" | "source";
  onPreviewModeChange?: (mode: "preview" | "source") => void;
  lineCount?: number;
  editable: boolean;
  readOnly: boolean;
  draft: FileEditorDraft | null;
  persistDraft: (draft: FileEditorDraft | null) => Promise<void>;
  disconnectedMessage: string;
  errorMessage: string | null;
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  imagePreviewUri: string | null;
}) {
  const getPreviewCopyText = useCallback(
    () => (preview?.kind === "text" ? (preview.content ?? "") : ""),
    [preview],
  );
  if (!client && readTarget && !draft) {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{disconnectedMessage}</Text>
        </View>
      </View>
    );
  }

  if (editable && readTarget && preview?.kind === "text") {
    return (
      <EditableFilePane
        key={`${serverId}:${readTarget.cwd}:${readTarget.path}`}
        client={client}
        serverId={serverId}
        workspaceId={workspaceId}
        readOnly={readOnly}
        draft={draft}
        persistDraft={persistDraft}
        cwd={readTarget.cwd}
        path={readTarget.path}
        preview={preview as TextExplorerFile}
        liveFile={liveFile}
        onRetryRead={onRetryRead}
        retryingRead={retryingRead}
        filename={filename}
        mode={previewMode}
        onModeChange={onPreviewModeChange}
        isLoading={isLoading}
        isMobile={isMobile}
        location={location}
        navigationRevision={navigationRevision}
      />
    );
  }

  if (errorMessage) {
    if (errorMessage === "File is too large to display") {
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <TooLargeSource />
        </View>
      );
    }
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <Button variant="outline" size="sm" onPress={onRetryRead} loading={retryingRead}>
            {retryLabel}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="workspace-file-pane">
      {preview ? (
        <FilePanelBar
          size={preview.size}
          lineCount={lineCount}
          mode={previewMode}
          onModeChange={onPreviewModeChange}
          getCopyText={preview.kind === "text" ? getPreviewCopyText : undefined}
        />
      ) : null}
      <FilePreviewBody
        preview={preview}
        mode={previewMode}
        isLoading={isLoading}
        isMobile={isMobile}
        location={location}
        navigationRevision={navigationRevision}
        imagePreviewUri={imagePreviewUri}
      />
    </View>
  );
}

function EditableFilePane({
  client,
  serverId,
  workspaceId,
  readOnly,
  draft,
  persistDraft,
  cwd,
  path,
  preview,
  liveFile,
  onRetryRead,
  retryingRead,
  filename,
  mode,
  onModeChange,
  isLoading,
  isMobile,
  location,
  navigationRevision,
}: {
  client: DaemonClient | null;
  serverId: string;
  workspaceId: string;
  readOnly: boolean;
  draft: FileEditorDraft | null;
  persistDraft: (draft: FileEditorDraft | null) => Promise<void>;
  cwd: string;
  path: string;
  preview: TextExplorerFile;
  liveFile: LiveFileModel;
  onRetryRead: () => void;
  retryingRead: boolean;
  filename: string;
  mode?: "preview" | "source";
  onModeChange?: (mode: "preview" | "source") => void;
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const { settings } = useAppSettings();
  const { t } = useTranslation();
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [vimMode, setVimMode] = useState<string | null>(settings.vimKeybindings ? "NORMAL" : null);
  const clientRef = useRef(client);
  useLayoutEffect(() => {
    clientRef.current = client;
  }, [client]);
  const session = useMemo(
    () => ({
      write(input: { content: string; expectedModifiedAt: string; expectedRevision?: string }) {
        const currentClient = clientRef.current;
        if (!currentClient) throw new Error(t("common.errors.daemonClientUnavailable"));
        return currentClient.writeFile({ cwd, path, ...input });
      },
    }),
    [cwd, path, t],
  );
  const [model] = useState(() => {
    return new FileEditorModel({
      file: {
        content: preview.content ?? "",
        hasBom: preview.hasBom,
        version: {
          status: "ready",
          cwd,
          path,
          size: preview.size,
          modifiedAt: preview.modifiedAt,
          revision: preview.revision,
        },
      },
      session,
      readOnly,
      draft,
      persistDraft,
    });
  });
  useLayoutEffect(() => model.setReadOnly(readOnly), [model, readOnly]);
  useLayoutEffect(
    () => workspaceFileEditors.register({ serverId, workspaceId }, model),
    [model, serverId, workspaceId],
  );
  useEffect(() => {
    const source = createFileObservationSource(liveFile);
    model.connectFileObservations(source);
    return () => model.disconnectFileObservations();
  }, [liveFile, model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const suspendPendingSave = useCallback(() => model.suspendAutosave(), [model]);
  const discardChanges = useCallback(() => model.discardRecoveryDraft(), [model]);
  usePublishPanelInstanceAttributes({
    modified: snapshot.modified,
    suspendPendingSave,
    discardChanges,
  });
  const [retryingCheckpoint, setRetryingCheckpoint] = useState(false);
  const retryCheckpoint = useCallback(async () => {
    setRetryingCheckpoint(true);
    try {
      await model.retryRecoveryDraft();
    } catch {
      // The model retains the failure for the inline recovery alert.
    } finally {
      setRetryingCheckpoint(false);
    }
  }, [model]);
  const theme = UnistylesRuntime.getTheme();
  const visualTheme = useMemo(
    () => ({
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [
      theme.colors.border,
      theme.colors.foreground,
      theme.colors.foregroundMuted,
      theme.colors.surface0,
      theme.colors.syntax,
      theme.colors.terminal.cursor,
      theme.colors.terminal.selectionBackground,
      theme.colorScheme,
      theme.fontFamily.mono,
      theme.fontSize.code,
    ],
  );

  useEffect(() => () => model.dispose(), [model]);

  const handleReload = useCallback(() => {
    if (!snapshot.modified) {
      void model.reload();
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("panels.file.editor.reloadTitle"),
        message: t("panels.file.editor.reloadMessage"),
        confirmLabel: t("panels.file.editor.reload"),
        destructive: true,
      });
      if (confirmed) void model.reload();
    })();
  }, [model, snapshot.modified, t]);
  const handleOverwrite = useCallback(() => void model.overwrite(), [model]);
  const conflict = fileConflictAlertState({
    callout: getFileConflictCallout(snapshot),
    onOverwrite: handleOverwrite,
    onReload: handleReload,
    onRetry: onRetryRead,
    retrying: retryingRead,
  });
  const handleVimModeChange = useCallback((nextMode: string | null) => setVimMode(nextMode), []);
  const getCopyText = useCallback(() => snapshot.content, [snapshot.content]);
  const renderedPreview = useMemo<ExplorerFile>(
    () => ({
      ...preview,
      content: snapshot.content,
      size: snapshot.version.status === "ready" ? snapshot.version.size : preview.size,
      modifiedAt:
        snapshot.version.status === "ready" ? snapshot.version.modifiedAt : preview.modifiedAt,
    }),
    [preview, snapshot.content, snapshot.version],
  );
  const showSource = mode !== "preview";

  return (
    <View style={styles.container} testID="workspace-file-pane">
      <FilePanelBar
        size={
          snapshot.observedVersion.status === "ready" ? snapshot.observedVersion.size : preview.size
        }
        lineCount={snapshot.content.split("\n").length}
        editorStatus={snapshot.status}
        cursor={showSource ? cursor : undefined}
        vimMode={showSource ? vimMode : null}
        conflict={conflict}
        mode={mode}
        onModeChange={onModeChange}
        getCopyText={getCopyText}
      />
      {snapshot.checkpointError ? (
        <Alert
          variant="error"
          title={t("panels.file.editor.recoverySaveError")}
          description={snapshot.checkpointError}
          testID="file-recovery-error"
        >
          <Button
            variant="outline"
            size="sm"
            onPress={retryCheckpoint}
            loading={retryingCheckpoint}
          >
            {t("common.actions.retry")}
          </Button>
        </Alert>
      ) : null}
      {showSource ? (
        <FileEditorView
          model={model}
          filename={filename}
          location={location}
          navigationRevision={navigationRevision}
          vimEnabled={settings.vimKeybindings}
          theme={visualTheme}
          onCursorChange={setCursor}
          onVimModeChange={handleVimModeChange}
        />
      ) : (
        <FilePreviewBody
          preview={renderedPreview}
          mode={mode}
          isLoading={isLoading}
          isMobile={isMobile}
          location={location}
          navigationRevision={navigationRevision}
          imagePreviewUri={null}
        />
      )}
    </View>
  );
}

function fileConflictAlertState(input: {
  callout: FileConflictCallout | null;
  onOverwrite(): void;
  onReload(): void;
  onRetry(): void;
  retrying: boolean;
}): FileConflictAlertState | undefined {
  if (!input.callout) return undefined;
  if (input.callout.kind === "deleted") return { kind: "deleted" };
  if (input.callout.kind === "checkFailed") {
    return { kind: "checkFailed", retrying: input.retrying, onRetry: input.onRetry };
  }
  return {
    kind: "changed",
    canOverwrite: input.callout.canOverwrite,
    onReload: input.onReload,
    onOverwrite: input.onOverwrite,
  };
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  loadingText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  binaryMetaText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  previewScrollContainer: {
    flex: 1,
    minHeight: 0,
  },
  previewContent: {
    flex: 1,
    minHeight: 0,
  },
  previewCodeScrollContent: {
    padding: theme.spacing[4],
  },
}));
