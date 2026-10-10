import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { Mic, MicOff, PhoneOff, Volume2, WifiLow } from "lucide-react-native";
import type { CallStatusKey } from "@/components/global-voice/call-status";
import { isNative } from "@/constants/platform";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import type { Theme } from "@/styles/theme";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import { getCarSignals } from "@/voice-chat/on-the-go/car-signals";
import type { OnTheGoReason } from "@/voice-chat/on-the-go/on-the-go-detector";
import { exitOnTheGo } from "@/voice-chat/on-the-go/use-on-the-go";
import type { GlobalVoice } from "@/voice-chat/use-global-voice";

const WHITE = "#ffffff";
const TILE_ICON_SIZE = 34;
const DETECTED_NOTICE_MS = 2_000;
const ENTER_FADE_MS = 250;
const KEEP_AWAKE_TAG = "paseo-on-the-go";
const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedMic = withUnistyles(Mic);
const ThemedWifiLow = withUnistyles(WifiLow);
const ThemedVolume = withUnistyles(Volume2);

function isDetected(reason: OnTheGoReason | null): boolean {
  return reason !== null && reason !== "manual" && reason !== "always";
}

function tapHaptic(style: Haptics.ImpactFeedbackStyle): void {
  if (isNative) void Haptics.impactAsync(style).catch(() => {});
}

/** Running agents and agents waiting on the user, across hosts, without the call's own agent. */
function useFleetSummary(): { working: number; needsYou: number } {
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
    return { working, needsYou };
  }, [agents, orchestratorAgentIds]);
}

/** The call screen while driving, after Google Meet's On-the-Go: big tiles, nothing small. */
export function OnTheGoContent({
  call,
  statusKey,
}: {
  call: GlobalVoice;
  statusKey: CallStatusKey;
}) {
  const { t } = useTranslation();
  useKeepAwake(KEEP_AWAKE_TAG);
  const fleet = useFleetSummary();
  const showAudioRoutePicker = useMemo(() => getCarSignals()?.showAudioRoutePicker ?? null, []);
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
    tapHaptic(Haptics.ImpactFeedbackStyle.Medium);
    call.toggleMute();
  }, [call]);
  const toggleWeakSignal = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Light);
    call.setWeakSignalMode(call.mode !== "messages");
  }, [call]);
  const pickAudio = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Light);
    showAudioRoutePicker?.();
  }, [showAudioRoutePicker]);
  const hangUp = useCallback(() => {
    tapHaptic(Haptics.ImpactFeedbackStyle.Heavy);
    call.stop();
  }, [call]);

  const isWeak = call.mode === "messages";
  const fleetLine = [
    fleet.working > 0 ? t("globalVoice.onTheGo.working", { count: fleet.working }) : null,
    fleet.needsYou > 0 ? t("globalVoice.onTheGo.needsYou", { count: fleet.needsYou }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const muteTile = (
    <Tile
      key="mute"
      label={call.isMuted ? t("globalVoice.onTheGo.unmute") : t("globalVoice.onTheGo.mute")}
      accessibilityLabel={
        call.isMuted ? t("globalVoice.actions.unmute") : t("globalVoice.actions.mute")
      }
      selected={call.isMuted}
      tone={call.isMuted ? "danger" : "neutral"}
      disabled={!call.isActive}
      onPress={toggleMute}
      testID="global-voice-mute"
      icon={call.isMuted ? "micOff" : "mic"}
    />
  );
  const weakTile = (
    <Tile
      key="weak"
      label={t("globalVoice.mode.weakShort")}
      accessibilityLabel={t("globalVoice.actions.weakSignal")}
      selected={isWeak}
      tone={isWeak ? "active" : "neutral"}
      disabled={!call.isActive || call.isSwitching || !call.canUseWeakSignal}
      onPress={toggleWeakSignal}
      testID="global-voice-on-the-go-weak-signal"
      icon="weak"
    />
  );
  const audioTile = showAudioRoutePicker ? (
    <Tile
      key="audio"
      label={t("globalVoice.onTheGo.audio")}
      accessibilityLabel={t("globalVoice.onTheGo.audio")}
      tone="neutral"
      onPress={pickAudio}
      testID="global-voice-on-the-go-audio"
      icon="audio"
    />
  ) : null;
  const endTile = (
    <Tile
      key="end"
      label={t("globalVoice.actions.end")}
      accessibilityLabel={t("globalVoice.actions.end")}
      tone="danger"
      onPress={hangUp}
      testID="global-voice-end"
      icon="end"
    />
  );

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
        hitSlop={8}
        style={styles.exit}
      >
        <Text style={styles.exitText}>
          {showDetected ? t("globalVoice.onTheGo.detected") : t("globalVoice.onTheGo.exit")}
        </Text>
      </Pressable>

      <View style={styles.info}>
        <View style={[styles.avatar, call.isMuted ? styles.avatarMuted : null]}>
          <Text style={styles.avatarLetter}>P</Text>
        </View>
        <Text style={styles.name}>Paseo</Text>
        <Text
          style={styles.status}
          accessibilityLiveRegion="polite"
          numberOfLines={2}
          testID="global-voice-status"
        >
          {t(`globalVoice.status.${statusKey}`, { count: call.messages.pendingSends })}
        </Text>
        {fleetLine ? (
          <Text style={styles.fleet} numberOfLines={1}>
            {fleetLine}
          </Text>
        ) : null}
      </View>

      <View style={styles.grid}>
        <View style={styles.gridRow}>
          {muteTile}
          {audioTile ?? weakTile}
        </View>
        <View style={styles.gridRow}>
          {audioTile ? weakTile : null}
          {endTile}
        </View>
      </View>
    </Animated.View>
  );
}

type TileTone = "neutral" | "active" | "danger";
type TileIcon = "mic" | "micOff" | "weak" | "audio" | "end";

function TileGlyph({ icon }: { icon: TileIcon }) {
  switch (icon) {
    case "micOff":
      return <MicOff size={TILE_ICON_SIZE} color={WHITE} strokeWidth={2.25} />;
    case "end":
      return <PhoneOff size={TILE_ICON_SIZE} color={WHITE} strokeWidth={2.25} />;
    case "weak":
      return (
        <ThemedWifiLow uniProps={foregroundColorMapping} size={TILE_ICON_SIZE} strokeWidth={2.25} />
      );
    case "audio":
      return (
        <ThemedVolume uniProps={foregroundColorMapping} size={TILE_ICON_SIZE} strokeWidth={2.25} />
      );
    default:
      return (
        <ThemedMic uniProps={foregroundColorMapping} size={TILE_ICON_SIZE} strokeWidth={2.25} />
      );
  }
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
        tone === "active" ? styles.tileActive : null,
        tone === "danger" ? styles.tileDanger : null,
        disabled ? styles.tileDisabled : null,
      ]}
    >
      <TileGlyph icon={icon} />
      <Text style={tone === "danger" ? styles.tileLabelOnColor : styles.tileLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  exit: {
    alignSelf: "center",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    marginTop: theme.spacing[2],
  },
  exitText: {
    fontSize: theme.fontSize.base,
    fontWeight: "500",
    color: theme.colors.accentBright,
  },
  info: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
    borderWidth: 3,
    borderColor: theme.colors.accent,
    marginBottom: theme.spacing[2],
  },
  avatarMuted: {
    borderColor: theme.colors.destructive,
  },
  avatarLetter: {
    fontFamily: "Georgia",
    fontSize: 42,
    color: theme.colors.foreground,
  },
  name: {
    fontSize: 24,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  status: {
    fontSize: 20,
    textAlign: "center",
    color: theme.colors.foregroundMuted,
  },
  fleet: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  grid: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  gridRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  tile: {
    flex: 1,
    height: 148,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface3,
  },
  tileActive: {
    backgroundColor: theme.colors.surface4,
    borderWidth: 2,
    borderColor: theme.colors.accent,
  },
  tileDanger: {
    backgroundColor: theme.colors.destructive,
  },
  tileDisabled: {
    opacity: 0.45,
  },
  tileLabel: {
    fontSize: 18,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  tileLabelOnColor: {
    fontSize: 18,
    fontWeight: "600",
    color: WHITE,
  },
}));
