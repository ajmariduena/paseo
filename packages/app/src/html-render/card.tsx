import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Maximize2 } from "lucide-react-native";
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

function HtmlRenderCardImpl({ client, serverId, agentId, render, theme }: CardProps) {
  const [expanded, setExpanded] = useState(false);
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
  const retryStyle = useMemo(() => ({ color: activeTheme.variables["--accent"] }), [activeTheme]);
  const expandStyle = useMemo(
    () => ({
      position: "absolute" as const,
      right: 0,
      top: 0,
      padding: 8,
      backgroundColor: activeTheme.variables["--background"],
    }),
    [activeTheme],
  );
  const { refetch } = fetched;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  return (
    <View style={cardStyle}>
      {message ? <Text style={hintStyle}>{message}</Text> : null}
      {fetched.error && client ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading HTML page"
          onPress={retry}
        >
          <Text style={retryStyle}>Retry</Text>
        </Pressable>
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Expand HTML page"
          onPress={open}
          style={expandStyle}
        >
          <Maximize2 size={16} color={activeTheme.variables["--muted-foreground"]} />
        </Pressable>
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
  );
}

const ThemedHtmlRenderCard = withUnistyles(HtmlRenderCardImpl);
const mapTheme = (theme: Theme) => ({ theme: mapRenderTheme(theme) });

export function HtmlRenderCard(props: Omit<CardProps, "theme">) {
  return <ThemedHtmlRenderCard {...props} uniProps={mapTheme} />;
}
