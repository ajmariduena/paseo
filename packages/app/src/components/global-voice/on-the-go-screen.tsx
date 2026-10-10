import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { Mic, MicOff, PhoneOff } from "lucide-react-native";
import { resolveGlowActivity, type CallStatusKey } from "@/components/global-voice/call-status";
import { VoiceGlow } from "@/components/global-voice/voice-glow";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import type { OnTheGoReason } from "@/voice-chat/on-the-go/on-the-go-detector";
import { exitOnTheGo } from "@/voice-chat/on-the-go/use-on-the-go";
import type { GlobalVoice } from "@/voice-chat/use-global-voice";

const WHITE = "#ffffff";
const ICON_SIZE = 48;
const DETECTED_NOTICE_MS = 2_000;
const ENTER_FADE_MS = 250;
const KEEP_AWAKE_TAG = "paseo-on-the-go";
const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedMic = withUnistyles(Mic);

function isDetected(reason: OnTheGoReason | null): boolean {
  return reason !== null && reason !== "manual" && reason !== "always";
}

/** The call screen while driving: one status word, a huge mute and a huge hang-up. */
export function OnTheGoContent({
  call,
  statusKey,
}: {
  call: GlobalVoice;
  statusKey: CallStatusKey;
}) {
  const { t } = useTranslation();
  useKeepAwake(KEEP_AWAKE_TAG);
  const [showDetected, setShowDetected] = useState(() =>
    isDetected(useGlobalVoiceStore.getState().onTheGoReason),
  );

  useEffect(() => {
    if (!showDetected) return;
    if (isNative) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
    const timer = setTimeout(() => setShowDetected(false), DETECTED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [showDetected]);

  const toggleMute = useCallback(() => {
    if (isNative) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    call.toggleMute();
  }, [call]);
  const hangUp = useCallback(() => {
    if (isNative) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    call.stop();
  }, [call]);

  return (
    <Animated.View
      entering={FadeIn.duration(ENTER_FADE_MS)}
      style={styles.root}
      testID="global-voice-on-the-go"
    >
      <View style={styles.banner}>
        <Pressable
          onPress={exitOnTheGo}
          accessibilityRole="button"
          accessibilityLabel={t("globalVoice.onTheGo.exit")}
          testID="global-voice-on-the-go-exit"
          hitSlop={8}
          style={[styles.exitPill, showDetected ? styles.exitPillDetected : null]}
        >
          <Text style={showDetected ? styles.exitTextDetected : styles.exitText}>
            {showDetected ? t("globalVoice.onTheGo.detected") : t("globalVoice.onTheGo.exit")}
          </Text>
        </Pressable>
      </View>

      <View style={styles.stage}>
        {call.isMuted ? null : <VoiceGlow activity={resolveGlowActivity(statusKey)} />}
        <Text
          style={styles.word}
          accessibilityLiveRegion="polite"
          numberOfLines={2}
          adjustsFontSizeToFit
          testID="global-voice-status"
        >
          {t(`globalVoice.status.${statusKey}`, { count: call.messages.pendingSends })}
        </Text>
      </View>

      <View style={styles.controls}>
        <Pressable
          onPress={toggleMute}
          disabled={!call.isActive}
          accessibilityRole="button"
          accessibilityLabel={
            call.isMuted ? t("globalVoice.actions.unmute") : t("globalVoice.actions.mute")
          }
          accessibilityState={call.isMuted ? SELECTED : NOT_SELECTED}
          testID="global-voice-mute"
          style={[styles.button, styles.muteButton, call.isMuted ? styles.muteButtonOn : null]}
        >
          {call.isMuted ? (
            <MicOff size={ICON_SIZE} color={WHITE} strokeWidth={2.25} />
          ) : (
            <ThemedMic uniProps={foregroundColorMapping} size={ICON_SIZE} strokeWidth={2.25} />
          )}
          <Text style={call.isMuted ? styles.buttonTextOnColor : styles.buttonText}>
            {call.isMuted ? t("globalVoice.onTheGo.unmute") : t("globalVoice.onTheGo.mute")}
          </Text>
        </Pressable>
        <Pressable
          onPress={hangUp}
          accessibilityRole="button"
          accessibilityLabel={t("globalVoice.actions.end")}
          testID="global-voice-end"
          style={[styles.button, styles.endButton]}
        >
          <PhoneOff size={ICON_SIZE * 0.75} color={WHITE} strokeWidth={2.25} />
          <Text style={styles.buttonTextOnColor}>{t("globalVoice.actions.end")}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  banner: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[3],
  },
  exitPill: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  exitPillDetected: {
    borderColor: theme.colors.accent,
  },
  exitText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  exitTextDetected: {
    fontSize: theme.fontSize.base,
    color: theme.colors.accentBright,
  },
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    paddingHorizontal: theme.spacing[6],
  },
  word: {
    fontFamily: "Georgia",
    fontSize: 56,
    lineHeight: 62,
    textAlign: "center",
    color: theme.colors.foreground,
  },
  controls: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  button: {
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  muteButton: {
    height: 200,
    backgroundColor: theme.colors.surface3,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.surface4,
  },
  muteButtonOn: {
    backgroundColor: theme.colors.destructive,
    borderColor: theme.colors.destructive,
  },
  endButton: {
    height: 112,
    flexDirection: "row",
    backgroundColor: theme.colors.destructive,
  },
  buttonText: {
    fontSize: 22,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  buttonTextOnColor: {
    fontSize: 22,
    fontWeight: "500",
    color: WHITE,
  },
}));
