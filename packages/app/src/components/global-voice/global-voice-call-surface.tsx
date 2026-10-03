import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Maximize2, Mic, MicOff, PhoneOff } from "lucide-react-native";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { VolumeMeter } from "@/components/volume-meter";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVoiceTelemetryOptional } from "@/contexts/voice-context";
import type { Theme } from "@/styles/theme";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import { useGlobalVoice, type GlobalVoice } from "@/voice-chat/use-global-voice";

const WHITE = "#ffffff";
const CAR_BUTTON_SIZE = 88;
const CAR_ICON_SIZE = 36;
const PILL_BUTTON_SIZE = 40;
const PILL_ICON_SIZE = 18;

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedMic = withUnistyles(Mic);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedMaximize = withUnistyles(Maximize2);
const ThemedSpinner = withUnistyles(LoadingSpinner);

type StatusKey = "connecting" | "listening" | "thinking" | "speaking" | "muted";

function resolveStatusKey(call: GlobalVoice): StatusKey {
  if (call.isStarting || call.phase === "starting") return "connecting";
  if (call.phase === "playing") return "speaking";
  if (call.phase === "submitting" || call.phase === "waiting") return "thinking";
  if (call.isMuted) return "muted";
  return "listening";
}

/** The global voice call UI: car-mode screen on phones, a floating pill everywhere else. */
export function GlobalVoiceCallSurface() {
  const call = useGlobalVoice();
  const isCompact = useIsCompactFormFactor();
  const isMinimized = useGlobalVoiceStore((state) => state.isMinimized);
  if (!call.isActive && !call.isStarting) return null;
  if (isCompact && !isMinimized) return <CarModeScreen call={call} />;
  return <CallPill call={call} isCompact={isCompact} />;
}

function CarModeScreen({ call }: { call: GlobalVoice }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const telemetry = useVoiceTelemetryOptional();
  const statusKey = resolveStatusKey(call);
  const minimize = useCallback(() => useGlobalVoiceStore.getState().setMinimized(true), []);

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={minimize}>
      <View
        style={[styles.carScreen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        testID="global-voice-car-mode"
      >
        <View style={styles.carHeader}>
          <Pressable
            onPress={minimize}
            accessibilityRole="button"
            accessibilityLabel={t("globalVoice.actions.minimize")}
            style={styles.carHeaderButton}
            hitSlop={12}
          >
            <ThemedChevronDown uniProps={mutedColorMapping} size={28} />
          </Pressable>
        </View>

        <View style={styles.carCenter}>
          <Text style={styles.carTitle}>Paseo</Text>
          <Text style={styles.carStatus} testID="global-voice-status">
            {t(`globalVoice.status.${statusKey}`)}
          </Text>
          <View style={styles.carMeter}>
            {call.isStarting ? (
              <ThemedSpinner uniProps={mutedColorMapping} size="large" />
            ) : (
              <VolumeMeter
                volume={telemetry?.volume ?? 0}
                isMuted={call.isMuted}
                isSpeaking={telemetry?.isSpeaking ?? false}
                orientation="horizontal"
              />
            )}
          </View>
        </View>

        <View style={styles.carActions}>
          <Pressable
            onPress={call.toggleMute}
            disabled={!call.isActive}
            accessibilityRole="button"
            accessibilityLabel={
              call.isMuted ? t("globalVoice.actions.unmute") : t("globalVoice.actions.mute")
            }
            testID="global-voice-mute"
            style={[
              styles.carButton,
              call.isMuted ? styles.carMuteButtonActive : styles.carMuteButton,
            ]}
          >
            {call.isMuted ? (
              <MicOff size={CAR_ICON_SIZE} color={WHITE} strokeWidth={2.25} />
            ) : (
              <ThemedMic
                uniProps={foregroundColorMapping}
                size={CAR_ICON_SIZE}
                strokeWidth={2.25}
              />
            )}
          </Pressable>
          <Pressable
            onPress={call.stop}
            accessibilityRole="button"
            accessibilityLabel={t("globalVoice.actions.end")}
            testID="global-voice-end"
            style={[styles.carButton, styles.endButton]}
          >
            <PhoneOff size={CAR_ICON_SIZE} color={WHITE} strokeWidth={2.25} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function CallPill({ call, isCompact }: { call: GlobalVoice; isCompact: boolean }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const telemetry = useVoiceTelemetryOptional();
  const statusKey = resolveStatusKey(call);
  const expand = useCallback(() => useGlobalVoiceStore.getState().setMinimized(false), []);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.pillAnchor, { bottom: insets.bottom + (isCompact ? 84 : 16) }]}
    >
      <View style={styles.pill} testID="global-voice-pill">
        {isCompact ? (
          <Pressable
            onPress={expand}
            accessibilityRole="button"
            accessibilityLabel={t("globalVoice.title")}
            style={styles.pillIconButton}
          >
            <ThemedMaximize uniProps={mutedColorMapping} size={PILL_ICON_SIZE} />
          </Pressable>
        ) : null}
        <View style={styles.pillMeter}>
          {call.isStarting ? (
            <ThemedSpinner uniProps={mutedColorMapping} size="small" />
          ) : (
            <VolumeMeter
              volume={telemetry?.volume ?? 0}
              isMuted={call.isMuted}
              isSpeaking={telemetry?.isSpeaking ?? false}
              orientation="horizontal"
              variant="compact"
            />
          )}
        </View>
        <Text style={styles.pillStatus} numberOfLines={1}>
          {t(`globalVoice.status.${statusKey}`)}
        </Text>
        <Pressable
          onPress={call.toggleMute}
          disabled={!call.isActive}
          accessibilityRole="button"
          accessibilityLabel={
            call.isMuted ? t("globalVoice.actions.unmute") : t("globalVoice.actions.mute")
          }
          style={[
            styles.pillButton,
            call.isMuted ? styles.pillMuteButtonActive : styles.pillMuteButton,
          ]}
        >
          {call.isMuted ? (
            <MicOff size={PILL_ICON_SIZE} color={WHITE} />
          ) : (
            <ThemedMic uniProps={foregroundColorMapping} size={PILL_ICON_SIZE} />
          )}
        </Pressable>
        <Pressable
          onPress={call.stop}
          accessibilityRole="button"
          accessibilityLabel={t("globalVoice.actions.end")}
          testID="global-voice-pill-end"
          style={[styles.pillButton, styles.endButton]}
        >
          <PhoneOff size={PILL_ICON_SIZE} color={WHITE} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  carScreen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  carHeader: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  carHeaderButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  carCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
  },
  carTitle: {
    fontFamily: "Georgia",
    fontSize: 44,
    color: theme.colors.foreground,
  },
  carStatus: {
    fontSize: 22,
    color: theme.colors.foregroundMuted,
  },
  carMeter: {
    height: 72,
    width: "70%",
    alignItems: "center",
    justifyContent: "center",
  },
  carActions: {
    flexDirection: "row",
    justifyContent: "space-evenly",
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[8],
  },
  carButton: {
    width: CAR_BUTTON_SIZE,
    height: CAR_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  carMuteButton: {
    backgroundColor: theme.colors.surface2,
  },
  carMuteButtonActive: {
    backgroundColor: theme.colors.palette.red[600],
  },
  endButton: {
    backgroundColor: theme.colors.palette.red[600],
  },
  pillAnchor: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 1000,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  pillIconButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  pillMeter: {
    width: 56,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  pillStatus: {
    minWidth: 72,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  pillButton: {
    width: PILL_BUTTON_SIZE,
    height: PILL_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  pillMuteButton: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  pillMuteButtonActive: {
    backgroundColor: theme.colors.palette.red[600],
  },
}));
