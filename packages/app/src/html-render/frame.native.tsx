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

export interface HtmlRenderFrameProps {
  html: string;
  renderId: string;
  title: string;
  height: number;
  theme: RenderTheme;
  fullscreen?: boolean;
}

export function HtmlRenderFrame(props: HtmlRenderFrameProps) {
  const nonce = useMemo(() => `${Date.now()}-${Math.random()}`, []);
  const initialTheme = useRef(props.theme).current;
  const document = useMemo(
    () =>
      prepareRenderDocument({
        html: props.html,
        theme: initialTheme,
        nonce,
        renderId: props.renderId,
        linkMode: "native",
      }),
    [props.html, initialTheme, nonce, props.renderId],
  );
  const source = useMemo(() => ({ html: document, baseUrl: "about:blank" }), [document]);
  const webviewRef = useRef<WebView>(null);
  const loadedRef = useRef<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const frameHeight = clampRenderHeight(Math.min(props.height, contentHeight ?? props.height));
  const frameStyle = useMemo(
    () =>
      props.fullscreen
        ? { flex: 1, backgroundColor: props.theme.variables["--background"] }
        : { height: frameHeight, backgroundColor: props.theme.variables["--background"] },
    [frameHeight, props.fullscreen, props.theme],
  );
  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (event.nativeEvent.data.length > 4096) return;
      let payload: unknown;
      try {
        payload = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      const message = readRenderBridgeMessage(payload, nonce, props.renderId);
      if (!message) return;
      if (message.method === "ui/notifications/size-changed" && "height" in message.params)
        setContentHeight(message.params.height);
    },
    [nonce, props.renderId],
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
  const themeUpdate = JSON.stringify(renderThemeMessage(props.theme));
  const sendTheme = useCallback(() => {
    webviewRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent("message", {data: ${themeUpdate}})); true;`,
    );
  }, [themeUpdate]);
  useEffect(() => {
    sendTheme();
  }, [sendTheme]);
  const onOpenWindow = useCallback((event: { nativeEvent: { targetUrl: string } }) => {
    const url = event.nativeEvent.targetUrl;
    if (isHttpUrl(url)) void openExternalUrl(url);
  }, []);
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
