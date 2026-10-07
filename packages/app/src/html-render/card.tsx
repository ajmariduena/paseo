import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Maximize2 } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import { withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import { HtmlRenderFrame } from "./frame";
import { mapRenderTheme, type RenderTheme } from "./document";
import type { HtmlRenderReference } from "./reference";
import { HtmlRenderViewer } from "./viewer";

interface CardProps {
  client: DaemonClient | null;
  serverId: string;
  agentId: string;
  render: HtmlRenderReference;
  theme?: RenderTheme;
}

const hoverTargetStyle = { position: "relative" as const };

function HtmlRenderCardImpl({ client, serverId, agentId, render, theme }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const isCompact = useIsCompactFormFactor();
  const showControls = isHovered || isFocused || isNative || isCompact;
  const activeTheme = theme!;
  const fetched = useFetchQuery({
    queryKey: ["html-render", serverId, agentId, render.renderId],
    dataShape: "value",
    immutableWhen: () => true,
    queryFn: () => {
      if (!client) throw new Error("Host disconnected");
      return client.getHtmlRender(agentId, render.renderId);
    },
    enabled: client !== null,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
  let message: string | null = null;
  if (!fetched.data) {
    if (!client) message = "Host disconnected";
    else if (fetched.isPending) message = "Loading HTML page…";
    else if (fetched.error) message = "Could not load HTML page";
  }
  const cardStyle = useMemo(
    () => ({
      width: "100%" as const,
      minHeight: fetched.data ? undefined : render.height,
      backgroundColor: activeTheme.variables["--background"],
      position: "relative" as const,
    }),
    [activeTheme, fetched.data, render.height],
  );
  const hintStyle = useMemo(
    () => ({ color: activeTheme.variables["--muted-foreground"], paddingVertical: 12 }),
    [activeTheme],
  );
  const controlsStyle = useMemo(
    () => ({
      height: 30,
      width: "100%" as const,
      alignItems: "flex-end" as const,
      opacity: showControls ? 1 : 0,
    }),
    [showControls],
  );
  const { refetch } = fetched;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => setIsFocused(false), []);
  return (
    <View
      style={hoverTargetStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <View style={cardStyle}>
        {message ? <Text style={hintStyle}>{message}</Text> : null}
        {fetched.error && client ? (
          <Button
            variant="ghost"
            size="xs"
            accessibilityLabel="Retry loading HTML page"
            onPress={retry}
          >
            Retry
          </Button>
        ) : null}
        {fetched.data ? (
          <HtmlRenderFrame
            html={fetched.data.html}
            renderId={render.renderId}
            title={render.title}
            height={render.height}
            theme={activeTheme}
          />
        ) : null}
        {fetched.data ? (
          <View style={controlsStyle} pointerEvents={showControls ? "auto" : "none"}>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={Maximize2}
              accessibilityLabel="Expand HTML page"
              onPress={open}
            >
              Expand
            </Button>
          </View>
        ) : null}
        {expanded && fetched.data ? (
          <HtmlRenderViewer
            html={fetched.data.html}
            renderId={render.renderId}
            title={render.title}
            height={render.height}
            theme={activeTheme}
            onClose={close}
          />
        ) : null}
      </View>
    </View>
  );
}

const ThemedHtmlRenderCard = withUnistyles(HtmlRenderCardImpl);
const mapTheme = (theme: Theme) => ({ theme: mapRenderTheme(theme) });

export function HtmlRenderCard(props: Omit<CardProps, "theme">) {
  return <ThemedHtmlRenderCard {...props} uniProps={mapTheme} />;
}
