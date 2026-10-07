import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl } from "@/utils/open-external-url";
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
  const frameRef = useRef<HTMLIFrameElement>(null);
  const nonce = useMemo(() => crypto.randomUUID(), []);
  const initialTheme = useRef(props.theme).current;
  const preparedDocument = useMemo(
    () => prepareRenderDocument(props.html, initialTheme, nonce, props.renderId),
    [props.html, initialTheme, nonce, props.renderId],
  );
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const frameHeight = props.fullscreen
    ? "100%"
    : clampRenderHeight(Math.min(props.height, contentHeight ?? props.height));
  const frameStyle = useMemo(
    () => ({
      display: "block" as const,
      border: 0,
      width: "100%",
      height: frameHeight,
      backgroundColor: props.theme.variables["--background"],
    }),
    [frameHeight, props.theme],
  );
  const onLoad = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(renderThemeMessage(props.theme), "*");
  }, [props.theme]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = readRenderBridgeMessage(event.data, nonce, props.renderId);
      if (!message) return;
      if (message.method === "ui/notifications/size-changed" && "height" in message.params) {
        setContentHeight(message.params.height);
      }
      if (message.method === "ui/open-link" && "url" in message.params) {
        if (document.activeElement === frame && navigator.userActivation?.isActive) {
          void openExternalUrl(message.params.url);
        }
        frame.contentWindow?.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [nonce, props.renderId]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(renderThemeMessage(props.theme), "*");
  }, [props.theme]);

  return (
    <iframe
      ref={frameRef}
      title={props.title}
      srcDoc={preparedDocument}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      style={frameStyle}
    />
  );
}
