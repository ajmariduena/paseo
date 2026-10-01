import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useTranslation } from "react-i18next";
import type { BrowserScreencastFrameMetadata } from "@getpaseo/protocol/binary-frames/index";
import type {
  BrowserRemoteCommand,
  BrowserScreencastInput,
  BrowserScreencastPageState,
} from "@getpaseo/protocol/browser-screencast/rpc-schemas";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useBrowserStore } from "@/desktop/browser/store";
import { createFrameSource } from "./frame-source";
import { FramePresenter, type FramePresentation } from "./frame-presenter";

export type RemoteBrowserStatus =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "paused" }
  | { kind: "error"; reason: RemoteBrowserFailure; message: string };

export type RemoteBrowserFailure =
  | "disconnected"
  | "update_daemon"
  | "update_desktop"
  | "no_desktop"
  | "tab_closed"
  | "unknown";

const EMPTY_PRESENTATION: FramePresentation = { layers: [null, null], visible: null };
const CAPTURE = { maxWidth: 1280, maxHeight: 1280, quality: 70 } as const;

export interface RemoteBrowserStream {
  status: RemoteBrowserStatus;
  /** Changes whenever the daemon starts a new stream, which starts without phone emulation. */
  subscriptionId: string | null;
  page: BrowserScreencastPageState | null;
  presentation: FramePresentation;
  visibleMetadata: BrowserScreencastFrameMetadata | null;
  layerLoaded: (layer: 0 | 1, sequence: number) => void;
  layerFailed: (layer: 0 | 1, sequence: number) => void;
  retry: () => void;
  sendInput: (input: BrowserScreencastInput) => Promise<boolean>;
  /** Resolves to an error message, or null when the desktop ran the command. */
  runCommand: (command: BrowserRemoteCommand) => Promise<string | null>;
}

export function useRemoteBrowserStream(input: {
  serverId: string;
  workspaceId: string;
  browserId: string;
  active: boolean;
}): RemoteBrowserStream {
  const { serverId, workspaceId, browserId, active } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.browserScreencast === true,
  );
  const foreground = useAppForeground();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<RemoteBrowserStatus>({ kind: "connecting" });
  const [page, setPage] = useState<BrowserScreencastPageState | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<FramePresentation>(EMPTY_PRESENTATION);
  const presenterRef = useRef<FramePresenter | null>(null);
  const subscriptionIdRef = useRef<string | null>(null);

  const rememberPage = useCallback(
    (next: BrowserScreencastPageState) => {
      setPage(next);
      const store = useBrowserStore.getState();
      store.adoptBrowser(browserId, { initialUrl: next.url });
      store.updateBrowser(browserId, {
        url: next.url,
        title: next.title,
        isLoading: next.isLoading,
        canGoBack: next.canGoBack,
        canGoForward: next.canGoForward,
      });
    },
    [browserId],
  );

  useEffect(() => {
    if (!active || !foreground) {
      setStatus({ kind: "paused" });
      return;
    }
    if (!client || !connected) {
      setStatus({ kind: "error", reason: "disconnected", message: "" });
      return;
    }
    if (!supported) {
      setStatus({ kind: "error", reason: "update_daemon", message: "" });
      return;
    }
    setStatus({ kind: "connecting" });
    const presenter = new FramePresenter({
      createSource: createFrameSource,
      onChange: setPresentation,
      ack: (sequence) => {
        const current = subscriptionIdRef.current;
        if (current) client.ackBrowserScreencastFrame(current, sequence);
      },
    });
    presenterRef.current = presenter;
    let observation: ReturnType<typeof client.observeBrowserScreencast>;
    try {
      observation = client.observeBrowserScreencast({ workspaceId, browserId, capture: CAPTURE });
    } catch (error) {
      presenter.dispose();
      presenterRef.current = null;
      setStatus({
        kind: "error",
        reason: "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const unsubscribe = observation.subscribe({
      snapshot: (snapshot) => {
        presenter.clear();
        subscriptionIdRef.current = snapshot.subscriptionId;
        setSubscriptionId(snapshot.subscriptionId);
        if (snapshot.page) rememberPage(snapshot.page);
        setStatus({ kind: "live" });
      },
      update: (message) => {
        if (message.type !== "browser.remote.screencast.update") return;
        if (message.payload.event.kind === "page") {
          rememberPage(message.payload.event.page);
          return;
        }
        presenter.clear();
        subscriptionIdRef.current = null;
        setStatus({
          kind: "error",
          reason: failureForCode(message.payload.event.error.code),
          message: message.payload.event.error.message,
        });
      },
      error: (error) => {
        setStatus({
          kind: "error",
          reason: failureForCode(readErrorCode(error)),
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const unsubscribeFrames = client.onBrowserScreencastFrame((frame) => {
      if (frame.id === subscriptionIdRef.current) presenter.push(frame);
    });
    return () => {
      unsubscribeFrames();
      unsubscribe();
      presenter.dispose();
      presenterRef.current = null;
      subscriptionIdRef.current = null;
      setSubscriptionId(null);
      void observation.release().catch(() => {});
    };
  }, [
    active,
    attempt,
    browserId,
    client,
    connected,
    foreground,
    rememberPage,
    supported,
    workspaceId,
  ]);

  const layerLoaded = useCallback((layer: 0 | 1, sequence: number) => {
    presenterRef.current?.loaded(layer, sequence);
  }, []);
  const layerFailed = useCallback((layer: 0 | 1, sequence: number) => {
    presenterRef.current?.failed(layer, sequence);
  }, []);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const sendInput = useCallback(
    async (next: BrowserScreencastInput) => {
      const current = subscriptionIdRef.current;
      if (!client || !current) return false;
      try {
        const reply = await client.sendBrowserScreencastInput(current, next);
        return reply.ok;
      } catch {
        return false;
      }
    },
    [client],
  );

  const runCommand = useCallback(
    async (command: BrowserRemoteCommand) => {
      if (!client) return t("workspace.browser.remote.errors.disconnected");
      try {
        const reply = await client.executeBrowserRemoteCommand({ workspaceId, command });
        return reply.ok
          ? null
          : (reply.error?.message ?? t("workspace.browser.remote.errors.unknown"));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [client, t, workspaceId],
  );

  const visibleMetadata = useMemo(() => {
    const { visible, layers } = presentation;
    return visible === null ? null : (layers[visible]?.metadata ?? null);
  }, [presentation]);

  return {
    status,
    subscriptionId,
    page,
    presentation,
    visibleMetadata,
    layerLoaded,
    layerFailed,
    retry,
    sendInput,
    runCommand,
  };
}

function useAppForeground(): boolean {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setState);
    return () => subscription.remove();
  }, []);
  return state !== "background";
}

function readErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function failureForCode(code: string | null): RemoteBrowserFailure {
  switch (code) {
    case "browser_no_host":
      return "no_desktop";
    case "browser_unsupported":
      return "update_desktop";
    case "browser_tab_not_found":
    case "browser_tab_closed":
      return "tab_closed";
    default:
      return "unknown";
  }
}
