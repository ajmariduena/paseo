import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  PanResponder,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type PanResponderGestureState,
  type TextInputKeyPressEventData,
} from "react-native";
import {
  ArrowLeft,
  ArrowRight,
  Keyboard,
  Monitor,
  RotateCw,
  Smartphone,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";
import { normalizeWorkspaceBrowserUrl } from "@/desktop/browser/store";
import { useToast } from "@/contexts/toast-context";
import { fitFrame, paneDragToWheel, panePointToPage, type PaneSize } from "./geometry";
import type { FrameLayer } from "./frame-presenter";
import {
  useRemoteBrowserStream,
  type RemoteBrowserFailure,
  type RemoteBrowserStream,
} from "./use-remote-browser-stream";

const TAP_SLOP = 10;
const MOBILE_DEVICE_SCALE_FACTOR = 2;
const VIEWPORT_RESIZE_DELAY_MS = 150;

type ViewMode = "web" | "mobile";
let lastViewMode: ViewMode = "web";
const viewModeByBrowserId = new Map<string, ViewMode>();
const TAP_MAX_MS = 600;
const WHEEL_INTERVAL_MS = 50;
const NAMED_KEYS = new Set([
  "Backspace",
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Delete",
]);

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const spinnerColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

interface RemoteBrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
}

export function RemoteBrowserPane({ browserId, serverId, workspaceId }: RemoteBrowserPaneProps) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const stream = useRemoteBrowserStream({ serverId, workspaceId, browserId, active });
  const { page, runCommand: runStreamCommand } = stream;
  const toast = useToast();
  const runCommand = useCallback(
    async (command: Parameters<RemoteBrowserStream["runCommand"]>[0]) => {
      const failure = await runStreamCommand(command);
      if (failure) toast.error(failure);
    },
    [runStreamCommand, toast],
  );
  const urlInputRef = useRef<EditingTextInputHandle | null>(null);
  const keyboardInputRef = useRef<EditingTextInputHandle | null>(null);
  const [urlFocused, setUrlFocused] = useState(false);
  const [pane, setPane] = useState<PaneSize | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => viewModeByBrowserId.get(browserId) ?? lastViewMode,
  );
  useMobileViewport({ stream, viewMode, pane });
  const toggleViewMode = useCallback(() => {
    setViewMode((current) => {
      const next = current === "web" ? "mobile" : "web";
      viewModeByBrowserId.set(browserId, next);
      lastViewMode = next;
      return next;
    });
  }, [browserId]);

  useEffect(() => {
    if (!urlFocused && page) urlInputRef.current?.replaceText(page.url);
  }, [page, urlFocused]);

  const goBack = useCallback(
    () => void runCommand({ command: "back", args: { browserId } }),
    [browserId, runCommand],
  );
  const goForward = useCallback(
    () => void runCommand({ command: "forward", args: { browserId } }),
    [browserId, runCommand],
  );
  const reload = useCallback(
    () => void runCommand({ command: "reload", args: { browserId } }),
    [browserId, runCommand],
  );
  const navigate = useCallback(() => {
    const draft = urlInputRef.current?.getText().trim() ?? "";
    if (!draft) return;
    urlInputRef.current?.blur();
    void runCommand({
      command: "navigate",
      args: { browserId, url: addressToUrl(draft) },
    });
  }, [browserId, runCommand]);
  const handleUrlFocus = useCallback(() => setUrlFocused(true), []);
  const handleUrlBlur = useCallback(() => setUrlFocused(false), []);
  const toggleKeyboard = useCallback(() => {
    const input = keyboardInputRef.current;
    if (!input) return;
    if (input.isFocused()) input.blur();
    else input.focus();
  }, []);

  const controlsDisabled = stream.status.kind !== "live";
  const backState = useMemo(
    () => ({ disabled: controlsDisabled || !page?.canGoBack }),
    [controlsDisabled, page?.canGoBack],
  );
  const forwardState = useMemo(
    () => ({ disabled: controlsDisabled || !page?.canGoForward }),
    [controlsDisabled, page?.canGoForward],
  );
  const reloadState = useMemo(() => ({ disabled: controlsDisabled }), [controlsDisabled]);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.browser.controls.back")}
          accessibilityState={backState}
          disabled={backState.disabled}
          onPress={goBack}
          style={backState.disabled ? styles.iconButtonDisabled : styles.iconButton}
        >
          <ThemedArrowLeft size={16} uniProps={mutedIconColorMapping} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.browser.controls.forward")}
          accessibilityState={forwardState}
          disabled={forwardState.disabled}
          onPress={goForward}
          style={forwardState.disabled ? styles.iconButtonDisabled : styles.iconButton}
        >
          <ThemedArrowRight size={16} uniProps={mutedIconColorMapping} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.browser.controls.refresh")}
          accessibilityState={reloadState}
          disabled={reloadState.disabled}
          onPress={reload}
          style={reloadState.disabled ? styles.iconButtonDisabled : styles.iconButton}
        >
          <ThemedRotateCw size={16} uniProps={mutedIconColorMapping} />
        </Pressable>
        <View style={styles.urlBar}>
          <TextInput
            ref={urlInputRef}
            accessibilityLabel={t("workspace.browser.controls.browserUrl")}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            selectTextOnFocus
            initialValue={page?.url ?? ""}
            placeholder={t("workspace.browser.controls.enterUrl")}
            onFocus={handleUrlFocus}
            onBlur={handleUrlBlur}
            onSubmitEditing={navigate}
            editable={!controlsDisabled}
            style={styles.urlInput}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.browser.remote.keyboard")}
          accessibilityState={reloadState}
          disabled={reloadState.disabled}
          onPress={toggleKeyboard}
          style={reloadState.disabled ? styles.iconButtonDisabled : styles.iconButton}
        >
          <ThemedKeyboard size={16} uniProps={mutedIconColorMapping} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            viewMode === "web"
              ? t("workspace.browser.remote.mobileView")
              : t("workspace.browser.remote.desktopView")
          }
          accessibilityState={reloadState}
          disabled={reloadState.disabled}
          onPress={toggleViewMode}
          style={reloadState.disabled ? styles.iconButtonDisabled : styles.iconButton}
        >
          {viewMode === "web" ? (
            <ThemedSmartphone size={16} uniProps={mutedIconColorMapping} />
          ) : (
            <ThemedMonitor size={16} uniProps={mutedIconColorMapping} />
          )}
        </Pressable>
      </View>
      <RemoteBrowserViewport stream={stream} pane={pane} onPaneChange={setPane} />
      <KeyboardRelay inputRef={keyboardInputRef} sendInput={stream.sendInput} />
    </View>
  );
}

function RemoteBrowserViewport(props: {
  stream: RemoteBrowserStream;
  pane: PaneSize | null;
  onPaneChange: (update: (current: PaneSize | null) => PaneSize | null) => void;
}) {
  const { stream, pane, onPaneChange: setPane } = props;
  const { t } = useTranslation();
  const [touching, setTouching] = useState(false);
  useBlockMobilePanelOpenGestures(touching);
  const fit = useMemo(() => fitFrame(pane, stream.visibleMetadata), [pane, stream.visibleMetadata]);
  const gesture = useViewportGesture({ fit, sendInput: stream.sendInput, setTouching });

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setPane((current) =>
        current && current.width === width && current.height === height
          ? current
          : { width, height },
      );
    },
    [setPane],
  );

  const { layers, visible } = stream.presentation;
  return (
    <View style={styles.viewport} onLayout={handleLayout} {...gesture.panHandlers}>
      <View style={styles.frames} pointerEvents="none">
        {layers[0] ? (
          <FrameImage
            index={0}
            layer={layers[0]}
            pane={pane}
            visible={visible === 0}
            onLoad={stream.layerLoaded}
            onError={stream.layerFailed}
          />
        ) : null}
        {layers[1] ? (
          <FrameImage
            index={1}
            layer={layers[1]}
            pane={pane}
            visible={visible === 1}
            onLoad={stream.layerLoaded}
            onError={stream.layerFailed}
          />
        ) : null}
      </View>
      <StatusOverlay stream={stream} hasFrame={visible !== null} t={t} />
    </View>
  );
}

function FrameImage(props: {
  index: 0 | 1;
  layer: FrameLayer;
  pane: PaneSize | null;
  visible: boolean;
  onLoad: (layer: 0 | 1, sequence: number) => void;
  onError: (layer: 0 | 1, sequence: number) => void;
}) {
  const { index, layer, pane, visible, onLoad, onError } = props;
  const fit = fitFrame(pane, layer.metadata);
  const source = useMemo(() => ({ uri: layer.source.uri }), [layer.source.uri]);
  const style = useMemo(
    () => [
      styles.frame,
      fit
        ? {
            left: fit.offsetX,
            top: fit.offsetY,
            width: fit.renderedWidth,
            height: fit.renderedHeight,
          }
        : styles.frameFill,
      visible ? null : styles.frameHidden,
    ],
    [fit, visible],
  );
  const handleLoad = useCallback(
    () => onLoad(index, layer.sequence),
    [index, layer.sequence, onLoad],
  );
  const handleError = useCallback(
    () => onError(index, layer.sequence),
    [index, layer.sequence, onError],
  );
  return (
    <Image
      accessibilityIgnoresInvertColors
      source={source}
      resizeMode="stretch"
      fadeDuration={0}
      onLoad={handleLoad}
      onError={handleError}
      style={style}
    />
  );
}

function StatusOverlay(props: {
  stream: RemoteBrowserStream;
  hasFrame: boolean;
  t: (key: string) => string;
}) {
  const { stream, hasFrame, t } = props;
  const { status } = stream;
  if (status.kind === "error") {
    return (
      <View style={styles.overlay}>
        <Text style={styles.overlayTitle}>{t(failureTitleKey(status.reason))}</Text>
        {status.reason === "unknown" && status.message ? (
          <Text style={styles.overlayMessage}>{status.message}</Text>
        ) : null}
        <Button variant="secondary" size="sm" onPress={stream.retry}>
          {t("workspace.browser.remote.retry")}
        </Button>
      </View>
    );
  }
  if (hasFrame) return null;
  return (
    <View style={styles.overlay} pointerEvents="none">
      <ThemedActivityIndicator uniProps={spinnerColorMapping} />
      <Text style={styles.overlayMessage}>{t("workspace.browser.remote.connecting")}</Text>
    </View>
  );
}

/**
 * In mobile view the desktop guest emulates a phone the size of this pane, so the page uses its
 * responsive layout. A new stream starts without emulation, which is why the subscription is a key.
 */
function useMobileViewport(input: {
  stream: RemoteBrowserStream;
  viewMode: ViewMode;
  pane: PaneSize | null;
}) {
  const { viewMode, pane } = input;
  const { subscriptionId, sendInput } = input.stream;
  const appliedRef = useRef<{ subscriptionId: string; key: string } | null>(null);
  const width = pane ? Math.round(pane.width) : 0;
  const height = pane ? Math.round(pane.height) : 0;

  useEffect(() => {
    if (!subscriptionId || width < 200 || height < 200) return;
    const key = viewMode === "mobile" ? `${width}x${height}` : "web";
    const applied = appliedRef.current;
    const appliedHere = applied?.subscriptionId === subscriptionId ? applied.key : "web";
    if (appliedHere === key) return;
    const timer = setTimeout(() => {
      appliedRef.current = { subscriptionId, key };
      void sendInput(
        viewMode === "mobile"
          ? {
              kind: "viewport",
              mobile: { width, height, deviceScaleFactor: MOBILE_DEVICE_SCALE_FACTOR },
            }
          : { kind: "viewport" },
      );
    }, VIEWPORT_RESIZE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [height, sendInput, subscriptionId, viewMode, width]);
}

function failureTitleKey(reason: RemoteBrowserFailure): string {
  switch (reason) {
    case "disconnected":
      return "workspace.browser.remote.errors.disconnected";
    case "update_daemon":
      return "workspace.browser.remote.errors.updateDaemon";
    case "update_desktop":
      return "workspace.browser.remote.errors.updateDesktop";
    case "no_desktop":
      return "workspace.browser.remote.errors.noDesktop";
    case "tab_closed":
      return "workspace.browser.remote.errors.tabClosed";
    case "unknown":
      return "workspace.browser.remote.errors.unknown";
  }
}

function useViewportGesture(input: {
  fit: ReturnType<typeof fitFrame>;
  sendInput: RemoteBrowserStream["sendInput"];
  setTouching: (touching: boolean) => void;
}) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    startedAt: number;
    scrolling: boolean;
    sentDx: number;
    sentDy: number;
    lastWheelAt: number;
  } | null>(null);

  return useMemo(() => {
    const flushWheel = (gestureState: PanResponderGestureState, force: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const now = Date.now();
      if (!force && now - gesture.lastWheelAt < WHEEL_INTERVAL_MS) return;
      const dx = gestureState.dx - gesture.sentDx;
      const dy = gestureState.dy - gesture.sentDy;
      if (dx === 0 && dy === 0) return;
      const { fit, sendInput } = inputRef.current;
      const anchor = panePointToPage(gesture.startX, gesture.startY, fit) ?? { x: 0, y: 0 };
      const wheel = paneDragToWheel(dx, dy, fit);
      gesture.sentDx = gestureState.dx;
      gesture.sentDy = gestureState.dy;
      gesture.lastWheelAt = now;
      if (wheel.deltaX === 0 && wheel.deltaY === 0) return;
      void sendInput({ kind: "wheel", x: anchor.x, y: anchor.y, ...wheel });
    };
    const finish = () => {
      gestureRef.current = null;
      inputRef.current.setTouching(false);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event: GestureResponderEvent) => {
        gestureRef.current = {
          startX: event.nativeEvent.locationX,
          startY: event.nativeEvent.locationY,
          startedAt: Date.now(),
          scrolling: false,
          sentDx: 0,
          sentDy: 0,
          lastWheelAt: 0,
        };
        inputRef.current.setTouching(true);
      },
      onPanResponderMove: (_event, gestureState) => {
        const gesture = gestureRef.current;
        if (!gesture) return;
        if (!gesture.scrolling && Math.hypot(gestureState.dx, gestureState.dy) > TAP_SLOP) {
          gesture.scrolling = true;
        }
        if (gesture.scrolling) flushWheel(gestureState, false);
      },
      onPanResponderRelease: (_event, gestureState) => {
        const gesture = gestureRef.current;
        if (gesture?.scrolling) {
          flushWheel(gestureState, true);
        } else if (gesture && Date.now() - gesture.startedAt <= TAP_MAX_MS) {
          const point = panePointToPage(gesture.startX, gesture.startY, inputRef.current.fit);
          if (point) void inputRef.current.sendInput({ kind: "click", x: point.x, y: point.y });
        }
        finish();
      },
      onPanResponderTerminate: finish,
    });
  }, []);
}

function KeyboardRelay(props: {
  inputRef: React.RefObject<EditingTextInputHandle | null>;
  sendInput: RemoteBrowserStream["sendInput"];
}) {
  const { inputRef, sendInput } = props;
  const handleChangeText = useCallback(
    (text: string) => {
      if (!text) return;
      inputRef.current?.reset();
      void sendInput({ kind: "text", text });
    },
    [inputRef, sendInput],
  );
  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = event.nativeEvent;
      if (NAMED_KEYS.has(key) && key !== "Enter") void sendInput({ kind: "key", key });
    },
    [sendInput],
  );
  const handleSubmit = useCallback(
    () => void sendInput({ kind: "key", key: "Enter" }),
    [sendInput],
  );
  return (
    <TextInput
      ref={inputRef}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      submitBehavior="submit"
      blurOnSubmit={false}
      onChangeText={handleChangeText}
      onKeyPress={handleKeyPress}
      onSubmitEditing={handleSubmit}
      style={styles.keyboardRelay}
    />
  );
}

function addressToUrl(draft: string): string {
  if (/\s/.test(draft) || !/[.:]/.test(draft)) {
    return `https://www.google.com/search?q=${encodeURIComponent(draft)}`;
  }
  return normalizeWorkspaceBrowserUrl(draft);
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonDisabled: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.45,
  },
  urlBar: {
    flex: 1,
    minWidth: 0,
    height: 32,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  urlInput: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  viewport: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
  },
  frames: {
    ...StyleSheet.absoluteFillObject,
  },
  frame: {
    position: "absolute",
  },
  frameFill: {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  },
  frameHidden: {
    opacity: 0,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  overlayTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foreground,
    textAlign: "center",
  },
  overlayMessage: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  keyboardRelay: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    left: -10,
    bottom: 0,
  },
}));
