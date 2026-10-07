import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebView } from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview";
import { openExternalUrl } from "@/utils/open-external-url";
import { isHttpUrl } from "@/utils/http-url";
import {
  clampRenderHeight,
  prepareRenderDocument,
  readRenderBridgeMessage,
  renderThemeMessage,
  type RenderTheme,
} from "./document";
import {
  isHttpsUrl,
  prepareVisualizationDocument,
  readNativeFollowUpUrl,
  readVisualizationBridgeMessage,
  VISUALIZATION_MAX_HEIGHT,
  VISUALIZATION_MIN_HEIGHT,
  visualizationReply,
  visualizationThemeMessage,
  type VisualizationFrameOptions,
} from "./visualize-bridge";

export interface HtmlRenderFrameProps {
  html: string;
  renderId: string;
  title: string;
  height: number;
  theme: RenderTheme;
  fullscreen?: boolean;
  visualization?: VisualizationFrameOptions;
}

export function HtmlRenderFrame(props: HtmlRenderFrameProps) {
  const nonce = useMemo(() => `${Date.now()}-${Math.random()}`, []);
  const initialTheme = useRef(props.theme).current;
  const initialVisualizationState = useRef(props.visualization?.state).current;
  const visualIdentity = props.visualization?.canonicalPath;
  const visualMode = props.visualization?.mode;
  const document = useMemo(() => {
    if (visualIdentity) {
      return prepareVisualizationDocument({
        fragment: props.html,
        theme: initialTheme,
        nonce,
        identity: visualIdentity,
        state: initialVisualizationState,
        mode: props.fullscreen ? "fullscreen" : (visualMode ?? "inline"),
        linkMode: "native",
      });
    }
    return prepareRenderDocument({
      html: props.html,
      theme: initialTheme,
      nonce,
      renderId: props.renderId,
      linkMode: "native",
    });
  }, [
    props.html,
    visualIdentity,
    initialVisualizationState,
    visualMode,
    props.fullscreen,
    initialTheme,
    nonce,
    props.renderId,
  ]);
  const source = useMemo(() => ({ html: document, baseUrl: "about:blank" }), [document]);
  const webviewRef = useRef<WebView>(null);
  const loadedRef = useRef<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const frameHeight = props.visualization
    ? Math.max(
        1,
        Math.min(VISUALIZATION_MAX_HEIGHT, Math.ceil(contentHeight ?? VISUALIZATION_MIN_HEIGHT)),
      )
    : clampRenderHeight(Math.min(props.height, contentHeight ?? props.height));
  const frameStyle = useMemo(
    () =>
      props.fullscreen
        ? { flex: 1, backgroundColor: props.theme.variables["--background"] }
        : { height: frameHeight, backgroundColor: props.theme.variables["--background"] },
    [frameHeight, props.fullscreen, props.theme],
  );
  const sendVisualizationReply = useCallback(
    (id: string, result: unknown, error: string | null) => {
      if (!props.visualization) return;
      const reply = visualizationReply(nonce, props.visualization.canonicalPath, id, result, error);
      webviewRef.current?.injectJavaScript(
        `window.dispatchEvent(new MessageEvent("message", {data: ${JSON.stringify(reply)}})); true;`,
      );
    },
    [nonce, props.visualization],
  );
  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (event.nativeEvent.data.length > (props.visualization ? 20_000 : 4096)) return;
      let payload: unknown;
      try {
        payload = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      const visual = props.visualization;
      if (visual) {
        const message = readVisualizationBridgeMessage(payload, nonce, visual.canonicalPath);
        if (!message) return;
        if (message.method === "visualization/size") {
          setContentHeight(message.params.height as number);
          return;
        }
        if (message.method === "visualization/set-state") {
          void visual.onSetState(message.params.state).then(
            (state) => sendVisualizationReply(message.id!, { state }, null),
            (error: unknown) => {
              visual.onError(error instanceof Error ? error.message : "State was not saved");
              sendVisualizationReply(message.id!, null, "State was not saved");
            },
          );
        }
        return;
      }
      const message = readRenderBridgeMessage(payload, nonce, props.renderId);
      if (!message) return;
      if (message.method === "ui/notifications/size-changed" && "height" in message.params)
        setContentHeight(message.params.height);
    },
    [nonce, props.renderId, props.visualization, sendVisualizationReply],
  );
  const allowOnlyDocument = useCallback(
    ({ url }: { url: string }) => {
      if (url.startsWith("about:blank#")) return true;
      if (url !== "about:blank" || loadedRef.current === document) return false;
      loadedRef.current = document;
      return true;
    },
    [document],
  );
  const themeUpdate = JSON.stringify(
    props.visualization
      ? visualizationThemeMessage(props.theme, nonce, props.visualization.canonicalPath)
      : renderThemeMessage(props.theme),
  );
  const sendTheme = useCallback(() => {
    webviewRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent("message", {data: ${themeUpdate}})); true;`,
    );
  }, [themeUpdate]);
  useEffect(() => {
    sendTheme();
  }, [sendTheme]);
  const followUpPending = useRef(false);
  const onOpenWindow = useCallback(
    (event: { nativeEvent: { targetUrl: string } }) => {
      const url = event.nativeEvent.targetUrl;
      const visual = props.visualization;
      if (visual) {
        const followUp = readNativeFollowUpUrl(url, nonce, visual.canonicalPath);
        if (followUp) {
          if (followUpPending.current) {
            sendVisualizationReply(followUp.id, null, "Follow-up already pending");
            return;
          }
          followUpPending.current = true;
          void visual
            .onFollowUp(followUp.prompt, followUp.title)
            .then(
              (sent) => sendVisualizationReply(followUp.id, { sent }, null),
              (error: unknown) => {
                visual.onError(error instanceof Error ? error.message : "Follow-up failed");
                sendVisualizationReply(followUp.id, null, "Follow-up failed");
              },
            )
            .finally(() => {
              followUpPending.current = false;
            });
          return;
        }
        if (isHttpsUrl(url)) void openExternalUrl(url);
        return;
      }
      if (isHttpUrl(url)) void openExternalUrl(url);
    },
    [nonce, props.visualization, sendVisualizationReply],
  );
  const overflows = contentHeight !== null && contentHeight > frameHeight;

  return (
    <WebView
      ref={webviewRef}
      source={source}
      style={frameStyle}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={allowOnlyDocument}
      onMessage={onMessage}
      onLoad={sendTheme}
      scrollEnabled={props.fullscreen || overflows}
      nestedScrollEnabled={!props.fullscreen && overflows}
      setSupportMultipleWindows
      javaScriptCanOpenWindowsAutomatically={false}
      onOpenWindow={onOpenWindow}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
    />
  );
}

const ORIGIN_WHITELIST = ["*"];
