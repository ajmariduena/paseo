import { touchTargetOutset } from "@/components/ui/control-geometry";

export type ComposerControlDensity = "full" | "condensed" | "tight";

export interface ComposerControlPresence {
  hasModel: boolean;
  /** The model has an effort scale, so the pill carries an effort suffix. */
  hasEffort: boolean;
  hasMode: boolean;
  features: readonly ComposerFeatureControlPresence[];
  fontScale: number;
  /** Labels the pill estimates its width from. */
  modelLabel: string;
  effortLabel: string;
  modeLabel: string;
}

export type ComposerFeatureControlPresence = { type: "toggle" } | { type: "select"; label: string };

/**
 * What each density keeps. The order controls give things up in, as the toolbar narrows:
 * effort suffix → mode label → carets → model label. The provider glyph and every control's
 * hit target stay at every density.
 */
export interface ComposerControlPresentation {
  showCarets: boolean;
  showEffortSuffix: boolean;
  showModeLabel: boolean;
  showModelLabel: boolean;
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
const LABEL_CHAR_WIDTH = 7;

function normalizedFontScale(fontScale: number): number {
  return Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
}

function sumControlWidths(widths: number[], controlGap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce((total, width) => total + width, 0) + (widths.length - 1) * controlGap;
}

function estimateLabelWidth(label: string, fontScale: number): number {
  return Array.from(label).length * LABEL_CHAR_WIDTH * fontScale;
}

function resolveFeatureControlWidth(
  feature: ComposerFeatureControlPresence,
  fontScale: number,
  aggregate: boolean,
): number {
  if (feature.type === "toggle" || aggregate) return COMPOSER_TOOLBAR_GEOMETRY.controlSize;
  return (
    COMPOSER_TOOLBAR_GEOMETRY.controlSize +
    COMPOSER_TOOLBAR_GEOMETRY.iconLabelGap +
    COMPOSER_TOOLBAR_GEOMETRY.labelPadding * 2 +
    estimateLabelWidth(feature.label, fontScale)
  );
}

/** The model · effort pill: glyph, then whatever labels the presentation keeps, then a caret. */
export function estimateModelPillWidth(
  controls: Pick<ComposerControlPresence, "hasEffort" | "fontScale" | "modelLabel" | "effortLabel">,
  presentation: Pick<
    ComposerControlPresentation,
    "showCarets" | "showEffortSuffix" | "showModelLabel"
  >,
): number {
  const fontScale = normalizedFontScale(controls.fontScale);
  const { controlSize, iconLabelGap, labelPadding, caretSize } = COMPOSER_TOOLBAR_GEOMETRY;
  let width = controlSize;
  if (presentation.showModelLabel) {
    width += iconLabelGap + estimateLabelWidth(controls.modelLabel, fontScale) + labelPadding;
  }
  if (controls.hasEffort && presentation.showEffortSuffix) {
    width += iconLabelGap + estimateLabelWidth(controls.effortLabel, fontScale);
  }
  if (presentation.showCarets) {
    width += iconLabelGap + caretSize;
  }
  return width;
}

function estimateModeWidth(
  controls: Pick<ComposerControlPresence, "fontScale" | "modeLabel">,
  showLabel: boolean,
): number {
  if (!showLabel) return COMPOSER_TOOLBAR_GEOMETRY.controlSize;
  const fontScale = normalizedFontScale(controls.fontScale);
  return (
    COMPOSER_TOOLBAR_GEOMETRY.controlSize +
    COMPOSER_TOOLBAR_GEOMETRY.iconLabelGap +
    estimateLabelWidth(controls.modeLabel, fontScale) +
    COMPOSER_TOOLBAR_GEOMETRY.labelPadding
  );
}

/** Total width the controls need at a density, across both toolbar clusters. */
export function estimateComposerControlsWidth(
  controls: ComposerControlPresence,
  density: ComposerControlDensity,
  controlGap: number,
): number {
  const presentation = resolveComposerControlPresentation(density);
  const fontScale = normalizedFontScale(controls.fontScale);
  const widths: number[] = [];
  if (controls.hasMode) widths.push(estimateModeWidth(controls, presentation.showModeLabel));
  if (presentation.aggregateFeatures) {
    if (controls.features.length > 0) widths.push(COMPOSER_TOOLBAR_GEOMETRY.controlSize);
  } else {
    for (const feature of controls.features) {
      widths.push(resolveFeatureControlWidth(feature, fontScale, false));
    }
  }
  if (controls.hasModel) widths.push(estimateModelPillWidth(controls, presentation));
  return sumControlWidths(widths, controlGap);
}

export function resolveComposerControlDensity(input: {
  availableWidth: number;
  currentDensity: ComposerControlDensity;
  controls: ComposerControlPresence;
  controlGap: number;
}): ComposerControlDensity {
  const fullFloor = estimateComposerControlsWidth(input.controls, "full", input.controlGap);
  const condensedFloor = estimateComposerControlsWidth(
    input.controls,
    "condensed",
    input.controlGap,
  );

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
      showEffortSuffix: true,
      showModeLabel: true,
      showModelLabel: true,
      aggregateFeatures: false,
    };
  }
  if (density === "condensed") {
    return {
      showCarets: false,
      showEffortSuffix: false,
      showModeLabel: false,
      showModelLabel: true,
      aggregateFeatures: true,
    };
  }
  return {
    showCarets: false,
    showEffortSuffix: false,
    showModeLabel: false,
    showModelLabel: false,
    aggregateFeatures: true,
  };
}

export function resolveComposerToolbarGlyphSize(platform: "web" | "native"): number {
  return platform === "native" ? 20 : 16;
}
