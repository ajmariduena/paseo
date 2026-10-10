import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { Mic, MicOff, PhoneOff } from "lucide-react-native";
import { resolveCallStatusKey, type CallStatusKey } from "@/components/global-voice/call-status";
import { Button } from "@/components/ui/button";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import type { OnTheGoReason } from "@/voice-chat/on-the-go/on-the-go-detector";
import { exitOnTheGo } from "@/voice-chat/on-the-go/use-on-the-go";
import type { GlobalVoice } from "@/voice-chat/use-global-voice";

const TILE_ICON_SIZE = 52;
const TILE_HEIGHT = 168;
const TILE_RADIUS = 32;
const STATUS_DOT_SIZE = 18;
const PANEL_RADIUS = 28;
const PANEL_BOTTOM_MIN = 16;
const SLIDE_MS = 220;
const DISMISS_DISTANCE = 48;
const KEEP_AWAKE_TAG = "paseo-on-the-go";
const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const invertedColorMapping = (theme: Theme) => ({ color: theme.colors.surface0 });
const onDestructiveColorMapping = (theme: Theme) => ({
  color: theme.colors.destructiveForeground,
});
const ThemedMic = withUnistyles(Mic);
const ThemedMicOff = withUnistyles(MicOff);
const ThemedPhoneOff = withUnistyles(PhoneOff);

function isDetected(reason: OnTheGoReason | null): boolean {
  return reason !== null && reason !== "manual" && reason !== "always";
}

type StatusTone = "ready" | "speaking" | "busy" | "alert";

function resolveStatusTone(statusKey: CallStatusKey): StatusTone {
  if (statusKey === "listening" || statusKey === "recording") return "ready";
  if (statusKey === "speaking") return "speaking";
  if (statusKey === "muted" || statusKey === "offline") return "alert";
  return "busy";
}

function tapHaptic(style: Haptics.ImpactFeedbackStyle): void {
  if (isNative) void Haptics.impactAsync(style).catch(() => {});
}

function minimizeCall(): void {
  useGlobalVoiceStore.getState().setMinimized(true);
}

/**
 * The call while driving: a panel docked over the app with one status line and two tiles.
 * Drag it down or tap the handle to fall back to the pill; the detector brings it back.
 */
export function OnTheGoPanel({ call }: { call: GlobalVoice }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  useKeepAwake(KEEP_AWAKE_TAG);
  const statusKey = resolveCallStatusKey(call);
  const statusTone = resolveStatusTone(statusKey);

  useEffect(() => {
    if (!isNative || !isDetected(useGlobalVoiceStore.getState().onTheGoReason)) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, []);

  const exit = useCallback(() => {
    exitOnTheGo();
    minimizeCall();
  }, []);
  const toggleMute = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Medium);
    call.toggleMute();
  }, [call]);
  const hangUp = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Heavy);
    call.stop();
  }, [call]);
  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetY(12)
        .onEnd((event) => {
          if (event.translationY > DISMISS_DISTANCE) minimizeCall();
        }),
    [],
  );

  return (
    <View pointerEvents="box-none" style={styles.anchor} testID="global-voice-on-the-go">
      <Animated.View
        entering={SlideInDown.duration(SLIDE_MS)}
        exiting={SlideOutDown.duration(SLIDE_MS)}
      >
        <GestureDetector gesture={dismissGesture}>
          <View
            collapsable={false}
            style={[styles.panel, { paddingBottom: Math.max(insets.bottom, PANEL_BOTTOM_MIN) }]}
          >
            <View style={styles.topRow}>
              <View style={styles.topSide} />
              <Pressable
                onPress={minimizeCall}
                accessibilityRole="button"
                accessibilityLabel={t("globalVoice.actions.minimize")}
                testID="global-voice-on-the-go-minimize"
                style={styles.handleArea}
              >
                <View style={styles.handle} />
              </Pressable>
              <View style={[styles.topSide, styles.topSideEnd]}>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={exit}
                  testID="global-voice-on-the-go-exit"
                  textStyle={styles.exitText}
                >
                  {t("globalVoice.onTheGo.exit")}
                </Button>
              </View>
            </View>

            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  statusTone === "ready" ? styles.statusDotReady : null,
                  statusTone === "speaking" ? styles.statusDotSpeaking : null,
                  statusTone === "busy" ? styles.statusDotBusy : null,
                  statusTone === "alert" ? styles.statusDotAlert : null,
                ]}
              />
              <Text
                style={styles.status}
                numberOfLines={1}
                adjustsFontSizeToFit
                accessibilityLiveRegion="polite"
                testID="global-voice-status"
              >
                {t(`globalVoice.status.${statusKey}`, { count: call.messages.pendingSends })}
              </Text>
            </View>

            <View style={styles.tiles}>
              <Tile
                label={
                  call.isMuted ? t("globalVoice.onTheGo.unmute") : t("globalVoice.onTheGo.mute")
                }
                accessibilityLabel={
                  call.isMuted ? t("globalVoice.actions.unmute") : t("globalVoice.actions.mute")
                }
                icon={call.isMuted ? "micOff" : "mic"}
                tone={call.isMuted ? "inverted" : "neutral"}
                selected={call.isMuted}
                disabled={!call.isActive}
                onPress={toggleMute}
                testID="global-voice-mute"
              />
              <Tile
                label={t("globalVoice.actions.end")}
                accessibilityLabel={t("globalVoice.actions.end")}
                icon="end"
                tone="danger"
                onPress={hangUp}
                testID="global-voice-end"
              />
            </View>
          </View>
        </GestureDetector>
      </Animated.View>
    </View>
  );
}

type TileTone = "neutral" | "inverted" | "danger";
type TileIcon = "mic" | "micOff" | "end";

function TileGlyph({ icon }: { icon: TileIcon }) {
  switch (icon) {
    case "micOff":
      return (
        <ThemedMicOff uniProps={invertedColorMapping} size={TILE_ICON_SIZE} strokeWidth={2.25} />
      );
    case "end":
      return (
        <ThemedPhoneOff
          uniProps={onDestructiveColorMapping}
          size={TILE_ICON_SIZE}
          strokeWidth={2.25}
        />
      );
    default:
      return (
        <ThemedMic uniProps={foregroundColorMapping} size={TILE_ICON_SIZE} strokeWidth={2.25} />
      );
  }
}

function resolveTileLabelStyle(tone: TileTone) {
  if (tone === "inverted") return styles.tileLabelInverted;
  if (tone === "danger") return styles.tileLabelOnColor;
  return styles.tileLabel;
}

function Tile({
  label,
  accessibilityLabel,
  icon,
  tone,
  selected,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  accessibilityLabel: string;
  icon: TileIcon;
  tone: TileTone;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  let selectedState: typeof SELECTED | undefined;
  if (selected !== undefined) selectedState = selected ? SELECTED : NOT_SELECTED;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selectedState}
      testID={testID}
      style={[
        styles.tile,
        tone === "inverted" ? styles.tileInverted : null,
        tone === "danger" ? styles.tileDanger : null,
        disabled ? styles.tileDisabled : null,
      ]}
    >
      <TileGlyph icon={icon} />
      <Text style={resolveTileLabelStyle(tone)}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
  },
  panel: {
    backgroundColor: theme.colors.surface1,
    borderTopLeftRadius: PANEL_RADIUS,
    borderTopRightRadius: PANEL_RADIUS,
    borderWidth: theme.borderWidth[1],
    borderBottomWidth: 0,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[1],
    gap: theme.spacing[3],
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  topSide: {
    flex: 1,
  },
  topSideEnd: {
    alignItems: "flex-end",
    // Pulls the label's ink onto the tiles' trailing rail; the ghost padding stays as hit area.
    marginRight: -theme.spacing[3],
  },
  handleArea: {
    width: 88,
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  handle: {
    width: 36,
    height: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface4,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[1],
  },
  statusDot: {
    width: STATUS_DOT_SIZE,
    height: STATUS_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
  statusDotReady: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  statusDotSpeaking: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  statusDotBusy: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  statusDotAlert: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  status: {
    flex: 1,
    fontSize: 40,
    lineHeight: 48,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  exitText: {
    color: theme.colors.foregroundMuted,
  },
  tiles: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  tile: {
    flex: 1,
    height: TILE_HEIGHT,
    borderRadius: TILE_RADIUS,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface3,
  },
  tileInverted: {
    backgroundColor: theme.colors.foreground,
  },
  tileDanger: {
    backgroundColor: theme.colors.destructive,
  },
  tileDisabled: {
    opacity: 0.45,
  },
  tileLabel: {
    fontSize: 24,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  tileLabelInverted: {
    fontSize: 24,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.surface0,
  },
  tileLabelOnColor: {
    fontSize: 24,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.destructiveForeground,
  },
}));
