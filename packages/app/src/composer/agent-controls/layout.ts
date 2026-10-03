import { touchTargetOutset } from "@/components/ui/control-geometry";

export type ComposerControlDensity = "full" | "condensed" | "tight";

export interface ComposerControlPresence {
  hasModel: boolean;
  hasThinking: boolean;
  hasMode: boolean;
  features: readonly ComposerFeatureControlPresence[];
  fontScale: number;
}

export type ComposerFeatureControlPresence = { type: "toggle" } | { type: "select"; label: string };

export interface ComposerControlPresentation {
  showCarets: boolean;
  showThinkingLabel: boolean;
  showModeLabel: boolean;
  aggregateFeatures: boolean;
}

export const COMPOSER_TOOLBAR_GEOMETRY = {
  controlSize: 28,
  controlGap: 4,
  // Under touch density: 28 + 12 makes an icon-only control's target 40 wide, and send/stop
  // become a visible 32 circle.
  touchControlGap: 12,
  primaryTouchSize: 32,
  iconLabelGap: 4,
  labelPadding: 8,
  caretSize: 14,
} as const;

export const COMPOSER_TOOLBAR_TOUCH_HIT_SLOP = {
  top: touchTargetOutset(COMPOSER_TOOLBAR_GEOMETRY.controlSize),
  bottom: touchTargetOutset(COMPOSER_TOOLBAR_GEOMETRY.controlSize),
  left: COMPOSER_TOOLBAR_GEOMETRY.touchControlGap / 2,
  right: COMPOSER_TOOLBAR_GEOMETRY.touchControlGap / 2,
} as const;

const DENSITY_HYSTERESIS = 12;

function normalizedFontScale(fontScale: number): number {
  return Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
}

function sumControlWidths(widths: number[], controlGap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce((total, width) => total + width, 0) + (widths.length - 1) * controlGap;
}

function estimateLabelWidth(label: string, fontScale: number): number {
  return Array.from(label).length * 7 * fontScale;
}

function resolveFeatureControlWidth(
  feature: ComposerFeatureControlPresence,
  fontScale: number,
): number {
  if (feature.type === "toggle") return COMPOSER_TOOLBAR_GEOMETRY.controlSize;
  return (
    COMPOSER_TOOLBAR_GEOMETRY.controlSize +
    COMPOSER_TOOLBAR_GEOMETRY.iconLabelGap +
    COMPOSER_TOOLBAR_GEOMETRY.labelPadding * 2 +
    estimateLabelWidth(feature.label, fontScale)
  );
}

function resolveCondensedFloor(controls: ComposerControlPresence, controlGap: number): number {
  const fontScale = normalizedFontScale(controls.fontScale);
  const widths: number[] = [];
  if (controls.hasModel) widths.push(36 + 60 * fontScale);
  if (controls.hasThinking) widths.push(COMPOSER_TOOLBAR_GEOMETRY.controlSize);
  if (controls.hasMode) widths.push(36 + 96 * fontScale);
  if (controls.features.length > 0) widths.push(COMPOSER_TOOLBAR_GEOMETRY.controlSize);
  return sumControlWidths(widths, controlGap);
}

function resolveFullFloor(controls: ComposerControlPresence, controlGap: number): number {
  const fontScale = normalizedFontScale(controls.fontScale);
  const widths: number[] = [];
  if (controls.hasModel) widths.push(50 + 70 * fontScale);
  if (controls.hasThinking) widths.push(54 + 48 * fontScale);
  if (controls.hasMode) widths.push(54 + 96 * fontScale);
  for (const feature of controls.features) {
    widths.push(resolveFeatureControlWidth(feature, fontScale));
  }
  return sumControlWidths(widths, controlGap);
}

export function resolveComposerControlDensity(input: {
  availableWidth: number;
  currentDensity: ComposerControlDensity;
  controls: ComposerControlPresence;
  controlGap: number;
}): ComposerControlDensity {
  const fullFloor = resolveFullFloor(input.controls, input.controlGap);
  const condensedFloor = resolveCondensedFloor(input.controls, input.controlGap);

  if (input.currentDensity === "full") {
    if (input.availableWidth >= fullFloor - DENSITY_HYSTERESIS) return "full";
    return input.availableWidth >= condensedFloor ? "condensed" : "tight";
  }

  if (input.currentDensity === "condensed") {
    if (input.availableWidth >= fullFloor + DENSITY_HYSTERESIS) return "full";
    if (input.availableWidth < condensedFloor - DENSITY_HYSTERESIS) return "tight";
    return "condensed";
  }

  if (input.availableWidth >= fullFloor + DENSITY_HYSTERESIS) return "full";
  if (input.availableWidth >= condensedFloor + DENSITY_HYSTERESIS) return "condensed";
  return "tight";
}

export function resolveComposerControlPresentation(
  density: ComposerControlDensity,
): ComposerControlPresentation {
  if (density === "full") {
    return {
      showCarets: true,
      showThinkingLabel: true,
      showModeLabel: true,
      aggregateFeatures: false,
    };
  }
  if (density === "condensed") {
    return {
      showCarets: false,
      showThinkingLabel: false,
      showModeLabel: true,
      aggregateFeatures: true,
    };
  }
  return {
    showCarets: false,
    showThinkingLabel: false,
    showModeLabel: false,
    aggregateFeatures: true,
  };
}

export function resolveComposerToolbarGlyphSize(platform: "web" | "native"): number {
  return platform === "native" ? 20 : 16;
}
