import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { Mic, MicOff, PhoneOff } from "lucide-react-native";
import { resolveCallStatusKey } from "@/components/global-voice/call-status";
import { Button } from "@/components/ui/button";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import type { OnTheGoReason } from "@/voice-chat/on-the-go/on-the-go-detector";
import { exitOnTheGo } from "@/voice-chat/on-the-go/use-on-the-go";
import type { GlobalVoice } from "@/voice-chat/use-global-voice";

const TILE_ICON_SIZE = 30;
const TILE_HEIGHT = 112;
const TILE_RADIUS = 24;
const PANEL_RADIUS = 28;
const PANEL_BOTTOM_MIN = 16;
const DETECTED_NOTICE_MS = 2_000;
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
            <Pressable
              onPress={minimizeCall}
              accessibilityRole="button"
              accessibilityLabel={t("globalVoice.actions.minimize")}
              testID="global-voice-on-the-go-minimize"
              style={styles.handleArea}
            >
              <View style={styles.handle} />
            </Pressable>

            <View style={styles.header}>
              <Text
                style={styles.status}
                numberOfLines={1}
                accessibilityLiveRegion="polite"
                testID="global-voice-status"
              >
                {t(`globalVoice.status.${statusKey}`, { count: call.messages.pendingSends })}
              </Text>
              <Button
                variant="ghost"
                size="md"
                onPress={exit}
                testID="global-voice-on-the-go-exit"
                style={styles.exit}
                textStyle={showDetected ? styles.exitTextDetected : styles.exitText}
              >
                {showDetected ? t("globalVoice.onTheGo.detected") : t("globalVoice.onTheGo.exit")}
              </Button>
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
  handleArea: {
    alignSelf: "center",
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 44,
  },
  status: {
    flex: 1,
    fontSize: theme.fontSize.xl,
    color: theme.colors.foreground,
  },
  exit: {
    // Pulls the label's ink onto the tiles' trailing rail; the ghost padding stays as hit area.
    marginRight: -theme.spacing[4],
  },
  exitText: {
    color: theme.colors.foregroundMuted,
  },
  exitTextDetected: {
    color: theme.colors.accentBright,
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
    gap: theme.spacing[2],
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
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  tileLabelInverted: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.surface0,
  },
  tileLabelOnColor: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.destructiveForeground,
  },
}));
