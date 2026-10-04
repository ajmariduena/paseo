import { Pause, Play, X } from "lucide-react-native";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  iconButtonChromeFrameStyle,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useControlDensity } from "@/constants/layout";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { pauseReadAloud, resumeReadAloud, stopReadAloud, useReadAloudStore } from "./player";
import { SpeakingBars } from "./speaking-bars";

/** Shows what is being read aloud while the user is somewhere other than that agent's chat. */
export function NowPlayingStrip({
  serverId,
  visibleAgentId,
}: {
  serverId: string;
  visibleAgentId: string | null;
}) {
  const track = useReadAloudStore((state) => state.track);
  const status = useReadAloudStore((state) => state.status);
  if (!track || !status) return null;
  if (track.serverId === serverId && track.agentId === visibleAgentId) return null;
  return (
    <NowPlayingStripContent
      serverId={track.serverId}
      agentId={track.agentId}
      preview={track.preview}
      status={status}
    />
  );
}

function NowPlayingStripContent({
  serverId,
  agentId,
  preview,
  status,
}: {
  serverId: string;
  agentId: string;
  preview: string;
  status: "preparing" | "playing" | "paused";
}) {
  const { t } = useTranslation();
  const density = useControlDensity();
  const engine = useVoiceAudioEngineOptional();
  const canPause = Boolean(engine?.pause && engine.resume);
  const title = useSessionStore(
    useCallback(
      (state) => {
        const session = state.sessions[serverId];
        const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
        return agent?.title ?? null;
      },
      [serverId, agentId],
    ),
  );

  const handleOpen = useCallback(() => {
    navigateToAgent({ serverId, agentId });
  }, [serverId, agentId]);
  const handleToggle = useCallback(() => {
    if (status === "paused") resumeReadAloud();
    else pauseReadAloud();
  }, [status]);

  const buttonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) =>
      iconButtonChromeStyle({ size: "large", state: { hovered, pressed }, density }),
    [density],
  );

  return (
    <View style={styles.container} testID="read-aloud-now-playing">
      <Pressable
        onPress={handleOpen}
        style={styles.summary}
        accessibilityRole="button"
        accessibilityLabel={title ?? t("agentList.fallbackTitle")}
        testID="read-aloud-now-playing-open"
      >
        <SpeakingBars height={14} active={status === "playing"} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {title ?? t("agentList.fallbackTitle")}
          </Text>
          <Text style={styles.preview} numberOfLines={1}>
            {preview}
          </Text>
        </View>
      </Pressable>
      {status === "preparing" ? (
        <View style={[iconButtonChromeFrameStyle("large"), styles.spinnerSlot]}>
          <LoadingSpinner color={styles.icon.color} style={styles.spinner} />
        </View>
      ) : null}
      {status !== "preparing" && canPause ? (
        <Pressable
          onPress={handleToggle}
          style={buttonStyle}
          accessibilityRole="button"
          accessibilityLabel={t(
            status === "paused"
              ? "message.actions.resumeReadingAloud"
              : "message.actions.pauseReadingAloud",
          )}
          testID="read-aloud-now-playing-toggle"
        >
          {status === "paused" ? (
            <Play size={ICON_SIZE.sm} color={styles.iconStrong.color} />
          ) : (
            <Pause size={ICON_SIZE.sm} color={styles.iconStrong.color} />
          )}
        </Pressable>
      ) : null}
      <Pressable
        onPress={stopReadAloud}
        style={buttonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("message.actions.stopReadingAloud")}
        testID="read-aloud-now-playing-stop"
      >
        <X size={ICON_SIZE.sm} color={styles.icon.color} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  summary: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  spinnerSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    width: ICON_SIZE.sm,
    height: ICON_SIZE.sm,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  iconStrong: {
    color: theme.colors.foreground,
  },
}));
