import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl } from "@/utils/open-external-url";
import type { RenderHeights } from "@getpaseo/protocol/html-render";
import {
  renderFrameHeight,
  prepareRenderDocument,
  readRenderBridgeMessage,
  renderThemeMessage,
  type RenderTheme,
} from "./document";
import {
  prepareVisualizationDocument,
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
  heights?: RenderHeights;
  theme: RenderTheme;
  fullscreen?: boolean;
  onHeightChange?: (height: number) => void;
  onHoverChange?: (hovered: boolean) => void;
  visualization?: VisualizationFrameOptions;
}

function handleVisualizationFrameMessage(input: {
  value: unknown;
  frame: HTMLIFrameElement;
  visual: VisualizationFrameOptions;
  nonce: string;
  followUpPending: { current: boolean };
  setContentHeight: (height: number) => void;
  onHoverChange?: (hovered: boolean) => void;
}) {
  const { value, frame, visual, nonce, followUpPending, setContentHeight, onHoverChange } = input;
  const message = readVisualizationBridgeMessage(value, nonce, visual.canonicalPath);
  if (!message) return;
  if (message.method === "visualization/size") {
    setContentHeight(message.params.height as number);
    return;
  }
  if (message.method === "visualization/hover") {
    onHoverChange?.(message.params.hovered as boolean);
    return;
  }
  const reply = (result: unknown, error: string | null) => {
    frame.contentWindow?.postMessage(
      visualizationReply(nonce, visual.canonicalPath, message.id!, result, error),
      "*",
    );
  };
  if (message.method === "visualization/set-state") {
    void visual.onSetState(message.params.state).then(
      (state) => reply({ state }, null),
      (error: unknown) => {
        visual.onError(error instanceof Error ? error.message : "State was not saved");
        reply(null, "State was not saved");
      },
    );
    return;
  }
  if (document.activeElement !== frame || !navigator.userActivation?.isActive) {
    reply(null, "User gesture required");
    return;
  }
  if (message.method === "visualization/open-external") {
    void openExternalUrl(message.params.url as string, true).then(
      () => reply({}, null),
      () => reply(null, "Could not open link"),
    );
    return;
  }
  if (followUpPending.current) {
    reply(null, "Follow-up already pending");
    return;
  }
  followUpPending.current = true;
  void visual
    .onFollowUp(message.params.prompt as string, message.params.title as string | undefined)
    .then(
      (sent) => reply({ sent }, null),
      (error: unknown) => {
        visual.onError(error instanceof Error ? error.message : "Follow-up failed");
        reply(null, "Follow-up failed");
      },
    )
    .finally(() => {
      followUpPending.current = false;
    });
}

export function HtmlRenderFrame(props: HtmlRenderFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const nonce = useMemo(() => crypto.randomUUID(), []);
  const initialTheme = useRef(props.theme).current;
  const initialVisualizationState = useRef(props.visualization?.state).current;
  const visualIdentity = props.visualization?.canonicalPath;
  const visualMode = props.visualization?.mode;
  const preparedDocument = useMemo(() => {
    if (visualIdentity) {
      return prepareVisualizationDocument({
        fragment: props.html,
        theme: initialTheme,
        nonce,
        identity: visualIdentity,
        state: initialVisualizationState,
        mode: props.fullscreen ? "fullscreen" : (visualMode ?? "inline"),
        linkMode: "web",
      });
    }
    return prepareRenderDocument({
      html: props.html,
      theme: initialTheme,
      nonce,
      renderId: props.renderId,
      linkMode: "web",
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
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  useEffect(() => setContentHeight(null), [props.renderId, visualIdentity]);
  const [frameWidth, setFrameWidth] = useState(728);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setFrameWidth(frame.getBoundingClientRect().width || 728);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  let frameHeight: string | number;
  if (props.fullscreen) frameHeight = "100%";
  else if (visualIdentity)
    frameHeight = Math.max(
      1,
      Math.min(VISUALIZATION_MAX_HEIGHT, Math.ceil(contentHeight ?? VISUALIZATION_MIN_HEIGHT)),
    );
  else frameHeight = renderFrameHeight(props.height, contentHeight, frameWidth, props.heights);
  const { fullscreen, onHeightChange } = props;
  useEffect(() => {
    if (!fullscreen && typeof frameHeight === "number") onHeightChange?.(frameHeight);
  }, [frameHeight, fullscreen, onHeightChange]);
  const frameStyle = useMemo(
    () => ({
      display: "block" as const,
      border: 0,
      width: "100%",
      height: frameHeight,
      backgroundColor: visualIdentity ? "transparent" : props.theme.variables["--background"],
    }),
    [frameHeight, props.theme, visualIdentity],
  );
  const onLoad = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      props.visualization
        ? visualizationThemeMessage(props.theme, nonce, props.visualization.canonicalPath)
        : renderThemeMessage(props.theme),
      "*",
    );
  }, [nonce, props.theme, props.visualization]);

  const followUpPending = useRef(false);
  const { onHoverChange, renderId, visualization } = props;

  useEffect(() => {
    function receive(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const visual = visualization;
      if (visual) {
        handleVisualizationFrameMessage({
          value: event.data,
          frame,
          visual,
          nonce,
          followUpPending,
          setContentHeight,
          onHoverChange,
        });
        return;
      }
      const message = readRenderBridgeMessage(event.data, nonce, renderId);
      if (!message) return;
      if (message.method === "ui/notifications/size-changed" && "height" in message.params) {
        setContentHeight(message.params.height);
      }
      if (message.method === "ui/notifications/hover-changed" && "hovered" in message.params) {
        onHoverChange?.(message.params.hovered);
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
  }, [nonce, onHoverChange, renderId, visualization]);

  useEffect(() => {
    onLoad();
  }, [onLoad]);

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
