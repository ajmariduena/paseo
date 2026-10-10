import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Car, ChevronDown, Maximize2, Mic, MicOff, PhoneOff, SignalLow } from "lucide-react-native";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { VoiceGlow } from "@/components/global-voice/voice-glow";
import {
  resolveCallStatusKey as resolveStatusKey,
  resolveGlowActivity,
  type CallStatusKey,
} from "@/components/global-voice/call-status";
import { OnTheGoContent } from "@/components/global-voice/on-the-go-screen";
import { VolumeMeter } from "@/components/volume-meter";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVoiceTelemetryOptional } from "@/contexts/voice-context";
import type { Theme } from "@/styles/theme";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import { enterOnTheGo, exitOnTheGo } from "@/voice-chat/on-the-go/use-on-the-go";
import {
  useGlobalVoice,
  useGlobalVoiceSupervisor,
  type GlobalVoice,
} from "@/voice-chat/use-global-voice";

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
const ThemedSignalLow = withUnistyles(SignalLow);
const ThemedCar = withUnistyles(Car);

const SWITCH_ON = { checked: true };
const SWITCH_OFF = { checked: false };

/** The global voice call UI: car-mode screen on phones, a floating pill everywhere else. */
export function GlobalVoiceCallSurface() {
  const call = useGlobalVoice();
  useGlobalVoiceSupervisor(call);
  const isCompact = useIsCompactFormFactor();
  const isMinimized = useGlobalVoiceStore((state) => state.isMinimized);
  if (!call.isActive && !call.isStarting) return null;
  if (isCompact && !isMinimized) return <CarModeScreen call={call} />;
  return <CallPill call={call} isCompact={isCompact} />;
}

function CarModeScreen({ call }: { call: GlobalVoice }) {
  const insets = useSafeAreaInsets();
  const statusKey = resolveStatusKey(call);
  const onTheGo = useGlobalVoiceStore((state) => state.onTheGo);
  const minimize = useCallback(() => useGlobalVoiceStore.getState().setMinimized(true), []);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onTheGo ? exitOnTheGo : minimize}
    >
      <View style={[styles.carScreen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {onTheGo ? (
          <OnTheGoContent call={call} statusKey={statusKey} />
        ) : (
          <CarModeContent call={call} statusKey={statusKey} minimize={minimize} />
        )}
      </View>
    </Modal>
  );
}

function CarModeContent({
  call,
  statusKey,
  minimize,
}: {
  call: GlobalVoice;
  statusKey: CallStatusKey;
  minimize: () => void;
}) {
  const { t } = useTranslation();
  const telemetry = useVoiceTelemetryOptional();

  return (
    <View style={styles.carContent} testID="global-voice-car-mode">
      <VoiceGlow activity={resolveGlowActivity(statusKey)} />
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
          {t(`globalVoice.status.${statusKey}`, { count: call.messages.pendingSends })}
        </Text>
        <View style={styles.carMeter}>
          {call.isStarting ? <ThemedSpinner uniProps={mutedColorMapping} size="large" /> : null}
          {!call.isStarting && isWeb ? (
            <VolumeMeter
              volume={telemetry?.volume ?? 0}
              isMuted={call.isMuted}
              isSpeaking={telemetry?.isSpeaking ?? false}
              orientation="horizontal"
            />
          ) : null}
        </View>
        {call.mode === "messages" && call.messages.lastSpoken ? (
          <Text style={styles.carTranscript} numberOfLines={3}>
            {call.messages.lastSpoken}
          </Text>
        ) : null}
      </View>

      <View style={styles.carModeRow}>
        <ModeSelector call={call} />
        <Pressable
          onPress={enterOnTheGo}
          disabled={!call.isActive}
          accessibilityRole="button"
          testID="global-voice-on-the-go-enter"
          hitSlop={8}
          style={styles.onTheGoLink}
        >
          <ThemedCar uniProps={mutedColorMapping} size={18} />
          <Text style={styles.onTheGoLinkText}>{t("globalVoice.onTheGo.enter")}</Text>
        </Pressable>
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
            <ThemedMic uniProps={foregroundColorMapping} size={CAR_ICON_SIZE} strokeWidth={2.25} />
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
  );
}

function resolveModeHintKey(call: GlobalVoice): string {
  if (!call.canUseWeakSignal) return "globalVoice.mode.weakUnavailable";
  if (call.mode === "live") return "globalVoice.mode.liveHint";
  return call.isAutoMode ? "globalVoice.mode.weakAutoHint" : "globalVoice.mode.weakHint";
}

/** Two explicit choices instead of a switch, so the active mode is always visible. */
function ModeSelector({ call }: { call: GlobalVoice }) {
  const { t } = useTranslation();
  const isWeak = call.mode === "messages";
  const disabled = !call.isActive || call.isSwitching;
  const chooseLive = useCallback(() => {
    if (isWeak) call.setWeakSignalMode(false);
  }, [call, isWeak]);
  const chooseWeak = useCallback(() => {
    if (!isWeak && call.canUseWeakSignal) call.setWeakSignalMode(true);
  }, [call, isWeak]);
  return (
    <View style={styles.modeSelector}>
      <View style={styles.modeSegments} accessibilityRole="radiogroup">
        <Pressable
          onPress={chooseLive}
          disabled={disabled}
          accessibilityRole="radio"
          accessibilityState={isWeak ? SWITCH_OFF : SWITCH_ON}
          testID="global-voice-mode-live"
          style={[styles.modeSegment, isWeak ? null : styles.modeSegmentActive]}
        >
          <ThemedMic uniProps={isWeak ? mutedColorMapping : foregroundColorMapping} size={18} />
          <Text style={isWeak ? styles.modeToggleText : styles.modeToggleTextOn}>
            {t("globalVoice.mode.live")}
          </Text>
        </Pressable>
        <Pressable
          onPress={chooseWeak}
          disabled={disabled || !call.canUseWeakSignal}
          accessibilityRole="radio"
          accessibilityState={isWeak ? SWITCH_ON : SWITCH_OFF}
          testID="global-voice-weak-signal"
          style={[
            styles.modeSegment,
            isWeak ? styles.modeSegmentActive : null,
            call.canUseWeakSignal ? null : styles.modeSegmentUnavailable,
          ]}
        >
          <ThemedSignalLow
            uniProps={isWeak ? foregroundColorMapping : mutedColorMapping}
            size={18}
          />
          <Text style={isWeak ? styles.modeToggleTextOn : styles.modeToggleText}>
            {t("globalVoice.mode.weakShort")}
          </Text>
        </Pressable>
      </View>
      <Text style={styles.modeHint} testID="global-voice-mode-hint">
        {t(resolveModeHintKey(call))}
      </Text>
    </View>
  );
}

function CallPill({ call, isCompact }: { call: GlobalVoice; isCompact: boolean }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const telemetry = useVoiceTelemetryOptional();
  const statusKey = resolveStatusKey(call);
  const expand = useCallback(() => useGlobalVoiceStore.getState().setMinimized(false), []);
  const toggleWeakSignal = useCallback(
    () => call.setWeakSignalMode(call.mode !== "messages"),
    [call],
  );

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
          {t(`globalVoice.status.${statusKey}`, { count: call.messages.pendingSends })}
        </Text>
        <Pressable
          onPress={toggleWeakSignal}
          disabled={!call.isActive || call.isSwitching || !call.canUseWeakSignal}
          accessibilityRole="switch"
          accessibilityState={call.mode === "messages" ? SWITCH_ON : SWITCH_OFF}
          accessibilityLabel={t("globalVoice.actions.weakSignal")}
          testID="global-voice-pill-weak-signal"
          style={[
            styles.pillButton,
            call.mode === "messages" ? styles.pillModeButtonActive : styles.pillMuteButton,
          ]}
        >
          <ThemedSignalLow
            uniProps={call.mode === "messages" ? foregroundColorMapping : mutedColorMapping}
            size={PILL_ICON_SIZE}
          />
        </Pressable>
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
  carContent: {
    flex: 1,
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
  carTranscript: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  carModeRow: {
    alignItems: "center",
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  onTheGoLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingHorizontal: theme.spacing[4],
  },
  onTheGoLinkText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textDecorationLine: "underline",
  },
  modeSelector: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
  },
  modeSegments: {
    flexDirection: "row",
    padding: 4,
    gap: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  modeSegment: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
  },
  modeSegmentActive: {
    backgroundColor: theme.colors.surface2,
  },
  modeSegmentUnavailable: {
    opacity: 0.45,
  },
  modeHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  modeToggleText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  modeToggleTextOn: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
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
  pillModeButtonActive: {
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
  },
}));
