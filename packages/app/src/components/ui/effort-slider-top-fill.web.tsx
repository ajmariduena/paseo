import { useEffect, useMemo, type CSSProperties } from "react";
import { withUnistyles } from "react-native-unistyles";
import { baseColors, type Theme } from "@/styles/theme";
import {
  EFFORT_TOP_PARTICLES,
  EFFORT_TOP_SHIMMER_DURATION_MS,
  EFFORT_TOP_SHIMMER_PEAK_OPACITY,
  EFFORT_TOP_SHIMMER_WIDTH_RATIO,
  type EffortTopParticle,
} from "./effort-slider-top-fill-model";

const KEYFRAME_STYLE_ID = "paseo-effort-top-fill-keyframes";
const SHIMMER_ANIMATION = "paseo-effort-top-shimmer";
const PARTICLE_ANIMATION = "paseo-effort-top-particle";

// Percent-based so one rule serves every track width. `--drift` and `--lift` are per particle.
const KEYFRAME_CSS = `
  @keyframes ${SHIMMER_ANIMATION} {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(${Math.round(100 / EFFORT_TOP_SHIMMER_WIDTH_RATIO)}%); }
  }
  @keyframes ${PARTICLE_ANIMATION} {
    0% { opacity: 0; transform: translate(0, 0); }
    50% { opacity: var(--peak); transform: translate(calc(var(--drift) / 2), var(--lift)); }
    100% { opacity: 0; transform: translate(var(--drift), 0); }
  }
`;

let keyframesRegistered = false;

function ensureKeyframes() {
  if (keyframesRegistered || document.getElementById(KEYFRAME_STYLE_ID)) {
    keyframesRegistered = true;
    return;
  }
  const styleElement = document.createElement("style");
  styleElement.id = KEYFRAME_STYLE_ID;
  styleElement.textContent = KEYFRAME_CSS;
  document.head.appendChild(styleElement);
  keyframesRegistered = true;
}

interface EffortSliderTopFillProps {
  width: number;
  height: number;
  reduceMotion: boolean;
  gradientFrom: string;
  gradientTo: string;
}

const FILL_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  pointerEvents: "none",
};

const SHIMMER_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  left: 0,
  width: `${EFFORT_TOP_SHIMMER_WIDTH_RATIO * 100}%`,
  background: `linear-gradient(90deg, transparent, rgba(255, 255, 255, ${EFFORT_TOP_SHIMMER_PEAK_OPACITY}), transparent)`,
  animationName: SHIMMER_ANIMATION,
  animationDuration: `${EFFORT_TOP_SHIMMER_DURATION_MS}ms`,
  animationTimingFunction: "linear",
  animationIterationCount: "infinite",
};

function particleStyle(particle: EffortTopParticle, width: number): CSSProperties {
  return {
    position: "absolute",
    left: `${particle.x * 100}%`,
    top: `${particle.y * 100}%`,
    width: particle.size,
    height: particle.size,
    borderRadius: particle.size / 2,
    backgroundColor: baseColors.white,
    opacity: 0,
    animationName: PARTICLE_ANIMATION,
    animationDuration: `${particle.durationMs}ms`,
    animationDelay: `${particle.delayMs}ms`,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    ["--peak" as string]: String(particle.peakOpacity),
    ["--drift" as string]: `${particle.driftX * width}px`,
    ["--lift" as string]: `${particle.liftY}px`,
  };
}

function TopFill({ width, reduceMotion, gradientFrom, gradientTo }: EffortSliderTopFillProps) {
  useEffect(() => {
    if (!reduceMotion) ensureKeyframes();
  }, [reduceMotion]);

  const fillStyle = useMemo<CSSProperties>(
    () => ({
      ...FILL_STYLE,
      backgroundImage: `linear-gradient(90deg, ${gradientFrom}, ${gradientTo})`,
    }),
    [gradientFrom, gradientTo],
  );
  const particles = useMemo(
    () =>
      EFFORT_TOP_PARTICLES.map((particle) => ({
        id: particle.id,
        style: particleStyle(particle, width),
      })),
    [width],
  );

  return (
    <div style={fillStyle}>
      {reduceMotion ? null : (
        <>
          <div style={SHIMMER_STYLE} />
          {particles.map((particle) => (
            <div key={particle.id} style={particle.style} />
          ))}
        </>
      )}
    </div>
  );
}

export const EffortSliderTopFill = withUnistyles(TopFill, (theme: Theme) => ({
  gradientFrom: theme.colors.statusMerged,
  gradientTo: theme.colors.palette.purple[500],
}));
