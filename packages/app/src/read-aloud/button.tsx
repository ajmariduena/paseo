import { Square, Volume2 } from "lucide-react-native";
import { createContext, memo, useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ToastApi } from "@/components/toast-host";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useVoiceAudioEngineOptional, useVoiceOptional } from "@/contexts/voice-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE } from "@/styles/theme";
import { startReadAloud, stopReadAloud, useReadAloudStore } from "./player";

// The speaker glyph sits lower in its box than Copy or Split, so it needs one size up to match them.
const SPEAKER_ICON_SIZE = ICON_SIZE.md;

export interface ReadAloudTarget {
  serverId: string;
  agentId: string;
  toast: ToastApi | null;
}

export const ReadAloudTargetContext = createContext<ReadAloudTarget | null>(null);

export const ReadAloudButton = memo(function ReadAloudButton({
  turnKey,
  getContent,
}: {
  turnKey: string;
  getContent: () => string;
}) {
  const { t } = useTranslation();
  const target = useContext(ReadAloudTargetContext);
  const engine = useVoiceAudioEngineOptional();
  const voice = useVoiceOptional();
  const serverId = target?.serverId ?? null;
  const agentId = target?.agentId ?? null;
  const playbackKey = serverId && agentId ? `${serverId}:${agentId}:${turnKey}` : null;

  const enabled = useSessionStore(
    useCallback(
      (state) =>
        serverId !== null &&
        state.sessions[serverId]?.serverInfo?.capabilities?.readAloud?.enabled === true,
      [serverId],
    ),
  );
  const status = useReadAloudStore(
    useCallback((state) => (state.activeKey === playbackKey ? state.status : null), [playbackKey]),
  );

  const handlePress = useCallback(() => {
    if (status) {
      stopReadAloud();
      return;
    }
    const text = getContent();
    const client = serverId ? getHostRuntimeStore().getClient(serverId) : null;
    if (!playbackKey || !engine || !client || !agentId || !text) return;
    startReadAloud({ key: playbackKey, text, agentId, client, engine }).catch((error: unknown) => {
      target?.toast?.error(error instanceof Error ? error.message : String(error));
    });
  }, [status, getContent, serverId, playbackKey, engine, agentId, target]);

  const inVoiceMode = serverId && agentId ? voice?.isVoiceModeForAgent(serverId, agentId) : false;
  if (!enabled || !engine || inVoiceMode) {
    return null;
  }

  return (
    <Pressable
      onPress={handlePress}
      style={styles.container}
      accessibilityRole="button"
      accessibilityLabel={t(
        status ? "message.actions.stopReadingAloud" : "message.actions.readAloud",
      )}
      testID="turn-read-aloud"
    >
      {({ hovered }) => {
        const iconColor = hovered ? styles.iconHoveredColor.color : styles.iconColor.color;
        return (
          <View style={styles.iconSlot}>
            {status === "preparing" ? (
              <LoadingSpinner color={iconColor} style={styles.spinner} />
            ) : null}
            {status === "playing" ? <Square size={ICON_SIZE.sm} color={iconColor} /> : null}
            {status === null ? <Volume2 size={SPEAKER_ICON_SIZE} color={iconColor} /> : null}
          </View>
        );
      }}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "center",
    padding: theme.spacing[1],
  },
  iconSlot: {
    width: SPEAKER_ICON_SIZE,
    height: SPEAKER_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    width: ICON_SIZE.sm,
    height: ICON_SIZE.sm,
    transform: [{ scale: 0.7 }],
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));
