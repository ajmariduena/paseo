import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import {
  AudioLines,
  Ellipsis,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  WifiLow,
  X,
} from "lucide-react-native";
import type { CallStatusKey } from "@/components/global-voice/call-status";
import { isNative } from "@/constants/platform";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import type { Theme } from "@/styles/theme";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import { getCarSignals } from "@/voice-chat/on-the-go/car-signals";
import type { OnTheGoReason } from "@/voice-chat/on-the-go/on-the-go-detector";
import { exitOnTheGo } from "@/voice-chat/on-the-go/use-on-the-go";
import type { GlobalVoice } from "@/voice-chat/use-global-voice";

const ENTER_FADE_MS = 250;
const KEEP_AWAKE_TAG = "paseo-on-the-go";
const STATE_ICON_SIZE = 56;
const BUTTON_ICON_SIZE = 36;
const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const invertedColorMapping = (theme: Theme) => ({ color: theme.colors.surface0 });
const onDestructiveColorMapping = (theme: Theme) => ({
  color: theme.colors.destructiveForeground,
});
const ThemedMic = withUnistyles(Mic);
const ThemedMicOff = withUnistyles(MicOff);
const ThemedAudioLines = withUnistyles(AudioLines);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedPhoneOff = withUnistyles(PhoneOff);
const ThemedVolume = withUnistyles(Volume2);
const ThemedWifiLow = withUnistyles(WifiLow);
const ThemedX = withUnistyles(X);

type StatusTone = "ready" | "speaking" | "busy" | "alert";

function resolveStatusTone(statusKey: CallStatusKey): StatusTone {
  if (statusKey === "listening" || statusKey === "recording") return "ready";
  if (statusKey === "speaking") return "speaking";
  if (statusKey === "muted" || statusKey === "offline") return "alert";
  return "busy";
}

function isDetected(reason: OnTheGoReason | null): boolean {
  return reason !== null && reason !== "manual" && reason !== "always";
}

function tapHaptic(style: Haptics.ImpactFeedbackStyle): void {
  if (isNative) void Haptics.impactAsync(style).catch(() => {});
}

/** Running agents and agents waiting on the user, across hosts, without the call's own agent. */
function useFleetLine(): string {
  const { t } = useTranslation();
  const { agents } = useAggregatedAgents({ demand: false });
  const orchestratorAgentIds = useGlobalVoiceStore((state) => state.orchestratorAgentIds);
  return useMemo(() => {
    const orchestrators = new Set(Object.values(orchestratorAgentIds));
    let working = 0;
    let needsYou = 0;
    for (const agent of agents) {
      if (orchestrators.has(agent.id)) continue;
      if ((agent.pendingPermissionCount ?? 0) > 0 || agent.requiresAttention) needsYou += 1;
      else if (agent.status === "running") working += 1;
    }
    const parts: string[] = [];
    if (working > 0) parts.push(t("globalVoice.onTheGo.working", { count: working }));
    if (needsYou > 0) parts.push(t("globalVoice.onTheGo.needsYou", { count: needsYou }));
    return parts.join(" · ");
  }, [agents, orchestratorAgentIds, t]);
}

function StateGlyph({ statusKey }: { statusKey: CallStatusKey }) {
  if (statusKey === "muted") {
    return <ThemedMicOff uniProps={foregroundColorMapping} size={STATE_ICON_SIZE} />;
  }
  if (statusKey === "speaking") {
    return <ThemedAudioLines uniProps={foregroundColorMapping} size={STATE_ICON_SIZE} />;
  }
  if (statusKey === "listening" || statusKey === "recording") {
    return <ThemedMic uniProps={foregroundColorMapping} size={STATE_ICON_SIZE} />;
  }
  return <ThemedEllipsis uniProps={foregroundColorMapping} size={STATE_ICON_SIZE} />;
}

function StateRing({ statusKey }: { statusKey: CallStatusKey }) {
  const tone = resolveStatusTone(statusKey);
  return (
    <View
      style={[
        styles.stateRing,
        tone === "ready" ? styles.ringReady : null,
        tone === "speaking" ? styles.ringSpeaking : null,
        tone === "busy" ? styles.ringBusy : null,
        tone === "alert" ? styles.ringAlert : null,
      ]}
    >
      <View style={styles.stateCore}>
        <StateGlyph statusKey={statusKey} />
      </View>
    </View>
  );
}

/**
 * The call while driving, after Google Meet's On-the-Go: an exit bar, the call state in large
 * type, a wide mute, the secondary actions and a full-width hang-up bar.
 */
export function OnTheGoContent({
  call,
  statusKey,
}: {
  call: GlobalVoice;
  statusKey: CallStatusKey;
}) {
  const { t } = useTranslation();
  useKeepAwake(KEEP_AWAKE_TAG);
  const fleetLine = useFleetLine();
  const showAudioRoutePicker = useMemo(() => getCarSignals()?.showAudioRoutePicker ?? null, []);
  const isWeak = call.mode === "messages";

  useEffect(() => {
    if (!isNative || !isDetected(useGlobalVoiceStore.getState().onTheGoReason)) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, []);

  const toggleMute = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Medium);
    call.toggleMute();
  }, [call]);
  const toggleWeakSignal = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Light);
    call.setWeakSignalMode(!isWeak);
  }, [call, isWeak]);
  const pickAudio = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Light);
    showAudioRoutePicker?.();
  }, [showAudioRoutePicker]);
  const hangUp = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Heavy);
    call.stop();
  }, [call]);

  return (
    <Animated.View
      entering={FadeIn.duration(ENTER_FADE_MS)}
      style={styles.root}
      testID="global-voice-on-the-go"
    >
      <Pressable
        onPress={exitOnTheGo}
        accessibilityRole="button"
        accessibilityLabel={t("globalVoice.onTheGo.exit")}
        testID="global-voice-on-the-go-exit"
        style={styles.exitBar}
      >
        <View style={styles.exitIcon}>
          <ThemedX uniProps={mutedColorMapping} size={24} />
        </View>
        <Text style={styles.exitText} numberOfLines={1}>
          {t("globalVoice.onTheGo.exit")}
        </Text>
        <View style={styles.exitIcon} />
      </Pressable>

      <View style={styles.info}>
        <Text
          style={styles.status}
          numberOfLines={1}
          adjustsFontSizeToFit
          accessibilityLiveRegion="polite"
          testID="global-voice-status"
        >
          {t(`globalVoice.status.${statusKey}`, { count: call.messages.pendingSends })}
        </Text>
        <Text style={styles.fleet} numberOfLines={1}>
          {fleetLine || " "}
        </Text>
        <StateRing statusKey={statusKey} />
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
          style={[
            styles.button,
            styles.muteButton,
            call.isMuted ? styles.buttonInverted : null,
            call.isActive ? null : styles.buttonDisabled,
          ]}
        >
          {call.isMuted ? (
            <ThemedMicOff uniProps={invertedColorMapping} size={BUTTON_ICON_SIZE} />
          ) : (
            <ThemedMic uniProps={foregroundColorMapping} size={BUTTON_ICON_SIZE} />
          )}
          <Text style={call.isMuted ? styles.buttonLabelInverted : styles.buttonLabel}>
            {call.isMuted ? t("globalVoice.onTheGo.unmute") : t("globalVoice.onTheGo.mute")}
          </Text>
        </Pressable>

        <View style={styles.row}>
          {showAudioRoutePicker ? (
            <Pressable
              onPress={pickAudio}
              accessibilityRole="button"
              accessibilityLabel={t("globalVoice.onTheGo.audio")}
              testID="global-voice-on-the-go-audio"
              style={[styles.button, styles.smallButton]}
            >
              <ThemedVolume uniProps={foregroundColorMapping} size={BUTTON_ICON_SIZE} />
              <Text style={styles.buttonLabel}>{t("globalVoice.onTheGo.audio")}</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={toggleWeakSignal}
            disabled={!call.isActive || call.isSwitching || !call.canUseWeakSignal}
            accessibilityRole="button"
            accessibilityLabel={t("globalVoice.actions.weakSignal")}
            accessibilityState={isWeak ? SELECTED : NOT_SELECTED}
            testID="global-voice-on-the-go-weak-signal"
            style={[
              styles.button,
              styles.smallButton,
              isWeak ? styles.buttonInverted : null,
              call.canUseWeakSignal ? null : styles.buttonDisabled,
            ]}
          >
            <ThemedWifiLow
              uniProps={isWeak ? invertedColorMapping : foregroundColorMapping}
              size={BUTTON_ICON_SIZE}
            />
            <Text style={isWeak ? styles.buttonLabelInverted : styles.buttonLabel}>
              {t("globalVoice.mode.weakShort")}
            </Text>
          </Pressable>
        </View>

        <Pressable
          onPress={hangUp}
          accessibilityRole="button"
          accessibilityLabel={t("globalVoice.actions.end")}
          testID="global-voice-end"
          style={styles.endBar}
        >
          <ThemedPhoneOff uniProps={onDestructiveColorMapping} size={30} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  exitBar: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    borderRadius: 16,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
  },
  exitIcon: {
    width: 32,
    alignItems: "center",
  },
  exitText: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentBright,
  },
  info: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  status: {
    fontSize: 36,
    lineHeight: 44,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  fleet: {
    fontSize: 17,
    color: theme.colors.foregroundMuted,
  },
  stateRing: {
    marginTop: theme.spacing[4],
    width: 160,
    height: 160,
    borderRadius: theme.borderRadius.full,
    borderWidth: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  ringReady: {
    borderColor: theme.colors.statusDotSuccess,
  },
  ringSpeaking: {
    borderColor: theme.colors.statusDotRunning,
  },
  ringBusy: {
    borderColor: theme.colors.statusDotWarning,
  },
  ringAlert: {
    borderColor: theme.colors.statusDotDanger,
  },
  stateCore: {
    width: 128,
    height: 128,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
  },
  controls: {
    gap: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  button: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  muteButton: {
    height: 152,
    borderRadius: 48,
  },
  smallButton: {
    flex: 1,
    height: 128,
    borderRadius: 40,
  },
  buttonInverted: {
    backgroundColor: theme.colors.foreground,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonLabel: {
    fontSize: 18,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  buttonLabelInverted: {
    fontSize: 18,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.surface0,
  },
  endBar: {
    height: 60,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.destructive,
  },
}));
