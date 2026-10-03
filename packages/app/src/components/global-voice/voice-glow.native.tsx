import { useEffect } from "react";
import {
  Blur,
  Canvas,
  Circle,
  Group,
  Paint,
  RadialGradient,
  vec,
} from "@shopify/react-native-skia";
import {
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { readAudioLevels } from "@/audio/audio-levels";
import type { VoiceGlowActivity, VoiceGlowProps } from "@/components/global-voice/voice-glow-types";

// Inspired by Voice from libraries.dev (MIT): soft lobes along the bottom edge that rise with
// whoever is speaking, gathering into one travelling mound while work is in progress.

const LOBES = 7;
const LEVELS_POLL_MS = 33;
const SENSITIVITY = 1.4;
const MAX_HEIGHT_RATIO = 0.3;
const LOBE_BASE_HEIGHT = 40;
const LOBE_BLUR = 34;
const CORE_BLUR = 14;
const ORIGIN = vec(0, 0);
const LOBE_STOPS = [0, 0.55, 1];
const CORE_STOPS = [0, 1];

const USER_COLORS = ["#00b4d8", "#0077b6", "#48cae4", "#90e0ef", "#3a86ff", "#4361ee", "#00f5d4"];
const ASSISTANT_COLORS = [
  "#ff4d6d",
  "#ff9f1c",
  "#ffd166",
  "#c77dff",
  "#4cc9f0",
  "#7b2ff7",
  "#f72585",
];

function toRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
const USER_RGB = USER_COLORS.map(toRgb);
const ASSISTANT_RGB = ASSISTANT_COLORS.map(toRgb);

const ACTIVITY_CODE: Record<VoiceGlowActivity, number> = {
  conversation: 0,
  processing: 1,
  connecting: 2,
};

interface GlowState {
  user: number;
  assistant: number;
  /** 0 = the user's colours, 1 = the assistant's. */
  mix: number;
  processing: number;
  connecting: number;
}

const INITIAL_STATE: GlowState = { user: 0, assistant: 0, mix: 1, processing: 0, connecting: 0 };

interface LobeProps {
  index: number;
  size: SharedValue<{ width: number; height: number }>;
  heights: SharedValue<number[]>;
  time: SharedValue<number>;
  state: SharedValue<GlowState>;
}

function Lobe({ index, size, heights, time, state }: LobeProps) {
  const transform = useDerivedValue(() => {
    const { width, height } = size.value;
    const lift = heights.value[index] ?? 0;
    const drift = 0.025 * Math.sin(time.value * 0.6 + index * 1.3);
    return [
      { translateX: ((index + 0.5) / LOBES + drift) * width },
      { translateY: height },
      { scaleX: Math.max(1, width * 0.2 * (1 + lift * 0.6)) },
      { scaleY: LOBE_BASE_HEIGHT + lift * height * MAX_HEIGHT_RATIO },
    ];
  });
  const colors = useDerivedValue(() => {
    const t = state.value.mix;
    const from = USER_RGB[index];
    const to = ASSISTANT_RGB[index];
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    const alpha = 0.3 + Math.min(0.4, (heights.value[index] ?? 0) * 0.9);
    return [
      `rgba(${r},${g},${b},${alpha})`,
      `rgba(${r},${g},${b},${alpha * 0.45})`,
      `rgba(${r},${g},${b},0)`,
    ];
  });
  return (
    <Group transform={transform}>
      <Circle cx={0} cy={0} r={1} blendMode="plus">
        <RadialGradient c={ORIGIN} r={1} colors={colors} positions={LOBE_STOPS} />
      </Circle>
    </Group>
  );
}

function Core({ size, time, state }: Pick<LobeProps, "size" | "time" | "state">) {
  const strength = useDerivedValue(() => {
    const { user, assistant, processing, connecting } = state.value;
    const breathe = 0.07 + 0.035 * Math.sin(time.value * 1.3);
    return Math.max(user, assistant, processing * 0.35, connecting * 0.2, breathe);
  });
  const transform = useDerivedValue(() => {
    const { width, height } = size.value;
    const travel = 0.5 + 0.38 * Math.sin(time.value * 1.5);
    const x = state.value.processing > 0.5 ? travel * width : width / 2;
    return [
      { translateX: x },
      { translateY: height },
      { scaleX: Math.max(1, width * (0.25 + strength.value * 0.45)) },
      { scaleY: 10 + strength.value * 60 },
    ];
  });
  const colors = useDerivedValue(() => [
    `rgba(255,255,255,${0.18 + strength.value * 0.35})`,
    "rgba(255,255,255,0)",
  ]);
  return (
    <Group transform={transform}>
      <Circle cx={0} cy={0} r={1} blendMode="plus">
        <RadialGradient c={ORIGIN} r={1} colors={colors} positions={CORE_STOPS} />
      </Circle>
    </Group>
  );
}

const LOBE_LAYER = (
  <Paint>
    <Blur blur={LOBE_BLUR} />
  </Paint>
);
const CORE_LAYER = (
  <Paint>
    <Blur blur={CORE_BLUR} />
  </Paint>
);

const LOBE_INDEXES = Array.from({ length: LOBES }, (_, index) => index);

/** A sound-reactive glow along the bottom of the call screen. */
export function VoiceGlow({ activity }: VoiceGlowProps) {
  const size = useSharedValue({ width: 0, height: 0 });
  const userTarget = useSharedValue(0);
  const assistantTarget = useSharedValue(0);
  const activityCode = useSharedValue(ACTIVITY_CODE[activity]);
  const time = useSharedValue(0);
  const heights = useSharedValue<number[]>(Array.from({ length: LOBES }, () => 0));
  const state = useSharedValue<GlowState>(INITIAL_STATE);

  useEffect(() => {
    activityCode.set(ACTIVITY_CODE[activity]);
  }, [activity, activityCode]);

  useEffect(() => {
    const timer = setInterval(() => {
      const levels = readAudioLevels();
      userTarget.set(Math.min(1, levels.user * SENSITIVITY));
      assistantTarget.set(Math.min(1, levels.assistant * SENSITIVITY));
    }, LEVELS_POLL_MS);
    return () => clearInterval(timer);
  }, [userTarget, assistantTarget]);

  useFrameCallback((frame) => {
    const steps = Math.min(4, (frame.timeSincePreviousFrame ?? 16.7) / 16.7);
    const ease = (current: number, target: number, attack: number, release: number) => {
      const rate = target > current ? attack : release;
      return current + (target - current) * (1 - Math.pow(1 - rate, steps));
    };
    const t = frame.timeSinceFirstFrame / 1000;
    time.set(t);

    const previous = state.get();
    const user = ease(previous.user, userTarget.get(), 0.45, 0.07);
    const assistant = ease(previous.assistant, assistantTarget.get(), 0.45, 0.07);
    // Whoever is louder owns the colour, eased so it never flickers between speakers.
    let speaker = previous.mix;
    if (assistant > user + 0.02) speaker = 1;
    else if (user > assistant + 0.02) speaker = 0;
    const code = activityCode.get();
    const next: GlowState = {
      user,
      assistant,
      mix: ease(previous.mix, speaker, 0.06, 0.06),
      processing: ease(previous.processing, code === 1 ? 1 : 0, 0.05, 0.05),
      connecting: ease(previous.connecting, code === 2 ? 1 : 0, 0.06, 0.06),
    };
    state.set(next);

    const level = Math.max(user, assistant);
    const breathe = 0.07 + 0.035 * Math.sin(t * 1.3);
    const travel = 0.5 + 0.38 * Math.sin(t * 1.5);
    const quiet = (1 - next.processing) * (1 - next.connecting);
    const current = heights.get();
    const updated: number[] = [];
    for (let index = 0; index < LOBES; index += 1) {
      const u = (index + 0.5) / LOBES;
      const centerWeight = 1 - Math.pow(Math.abs(u - 0.5) * 2, 1.6) * 0.65;
      const wobble =
        0.5 +
        0.25 * Math.sin(t * (1 + level) * 1.7 + index * 2.1) +
        0.15 * Math.sin(t * (1 + level) * 3.1 + index * 5.3) +
        0.1 * Math.sin(t * (1 + level) * 0.7 + index);
      const voice = level * centerWeight * (0.55 + 0.6 * wobble);
      const distance = u - travel;
      const mound = Math.exp(-(distance * distance) / 0.02) * 0.42;
      const pulse = (0.12 + 0.1 * Math.sin(t * 4 - index * 0.9)) * centerWeight;
      const target =
        Math.max(breathe * centerWeight, voice) * quiet +
        mound * next.processing +
        pulse * next.connecting;
      updated.push(ease(current[index] ?? 0, target, 0.35, 0.12));
    }
    heights.set(updated);
  });

  return (
    <Canvas pointerEvents="none" style={StyleSheet.absoluteFill} onSize={size}>
      <Group layer={LOBE_LAYER}>
        {LOBE_INDEXES.map((index) => (
          <Lobe key={index} index={index} size={size} heights={heights} time={time} state={state} />
        ))}
      </Group>
      <Group layer={CORE_LAYER}>
        <Core size={size} time={time} state={state} />
      </Group>
    </Canvas>
  );
}
