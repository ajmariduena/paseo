import { touchTargetOutset } from "@/components/ui/control-geometry";

export const COMPOSER_CONTROL_DENSITIES = [
  "full",
  "no-effort",
  "no-mode",
  "condensed",
  "tight",
  "icons",
] as const;
export type ComposerControlDensity = (typeof COMPOSER_CONTROL_DENSITIES)[number];

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
 * effort suffix → mode label → carets → model label → the quick-prompt slot. Every control's
 * hit target stays at every density; once the model label is gone the trigger is the gauge.
 */
export interface ComposerControlPresentation {
  showCarets: boolean;
  showEffortSuffix: boolean;
  showModeLabel: boolean;
  showModelLabel: boolean;
  /** Extra provider features leave the toolbar for the Advanced page (or one badge without a trigger). */
  aggregateFeatures: boolean;
  /** `icons` is the phone row: quick prompts live in the attachment menu instead of the toolbar. */
  showQuickPromptTrigger: boolean;
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
    // With a trigger the features live on its Advanced page; the badge only stands in without one.
    if (controls.features.length > 0 && !controls.hasModel) {
      widths.push(COMPOSER_TOOLBAR_GEOMETRY.controlSize);
    }
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
  return resolveDensityWithHysteresis(input.availableWidth, input.currentDensity, (density) =>
    estimateComposerControlsWidth(input.controls, density, input.controlGap),
  );
}

function resolveDensityWithHysteresis(
  availableWidth: number,
  current: ComposerControlDensity | undefined,
  floor: (density: ComposerControlDensity) => number,
): ComposerControlDensity {
  const currentIndex = current === undefined ? -1 : COMPOSER_CONTROL_DENSITIES.indexOf(current);
  for (const [index, density] of COMPOSER_CONTROL_DENSITIES.entries()) {
    let threshold = floor(density);
    if (currentIndex >= 0 && index < currentIndex) threshold += DENSITY_HYSTERESIS;
    if (index === currentIndex) threshold -= DENSITY_HYSTERESIS;
    if (availableWidth >= threshold) return density;
  }
  return "icons";
}

export function resolveComposerControlPresentation(
  density: ComposerControlDensity,
): ComposerControlPresentation {
  return {
    showEffortSuffix: density === "full",
    showModeLabel: density === "full" || density === "no-effort",
    showCarets: density === "full" || density === "no-effort" || density === "no-mode",
    showModelLabel: density !== "tight" && density !== "icons",
    aggregateFeatures: density !== "full",
    showQuickPromptTrigger: density !== "icons",
  };
}

/** The toolbar trigger reads the model name while it fits and becomes the gauge once it doesn't. */
export function resolveIntelligenceTriggerKind(
  presentation: Pick<ComposerControlPresentation, "showModelLabel">,
): "pill" | "gauge" {
  return presentation.showModelLabel ? "pill" : "gauge";
}

export function resolveComposerToolbarGlyphSize(platform: "web" | "native"): number {
  return platform === "native" ? 20 : 16;
}

export interface QuickPromptPresentation {
  /** False moves the picker into the attachment menu and the feedback above the input. */
  showTrigger: boolean;
  showDefaultLabel: boolean;
  visiblePinCount: number;
  width: number;
  density: ComposerControlDensity;
}

const PHONE_QUICK_PROMPT_PRESENTATION: QuickPromptPresentation = {
  showTrigger: false,
  showDefaultLabel: false,
  visiblePinCount: 0,
  width: 0,
  density: "icons",
};

/** Attachment, context ring, mic and send/stop retain their complete target frames. */
export function estimateComposerFixedWidth(touch: boolean): number {
  return touch
    ? 4 * 44
    : 4 * COMPOSER_TOOLBAR_GEOMETRY.controlSize + 5 * COMPOSER_TOOLBAR_GEOMETRY.controlGap;
}

/** A bounded pill includes its bookmark, padding and one line of text. */
export function estimateQuickPromptPillWidth(label: string, fontScale: number): number {
  return (
    44 + estimateLabelWidth(Array.from(label).slice(0, 14).join(""), normalizedFontScale(fontScale))
  );
}

/**
 * Resolve the joint budget: secondary pins disappear first, then model/effort/mode labels,
 * then the default prompt label, and last the icon-only trigger itself. Both clusters consume
 * this same decision, so a prompt cannot keep the model at a density whose labels would
 * overflow the remaining space. Compact layouts are the phone row outright.
 */
export function resolveQuickPromptPresentation(input: {
  /** Button-row interior after the fixed attachment/ring/mic/send slots. */
  availableWidth: number;
  compact: boolean;
  touch: boolean;
  defaultLabel: string | null;
  pinnedLabels: readonly string[];
  controls: ComposerControlPresence;
  current?: QuickPromptPresentation;
}): QuickPromptPresentation {
  if (input.compact) return PHONE_QUICK_PROMPT_PRESENTATION;
  const gap = input.touch
    ? COMPOSER_TOOLBAR_GEOMETRY.touchControlGap
    : COMPOSER_TOOLBAR_GEOMETRY.controlGap;
  const target = input.touch ? 44 : 28;
  const pillWidth = (label: string) =>
    estimateQuickPromptPillWidth(label, input.controls.fontScale);
  const splitWidth = input.defaultLabel === null ? 0 : pillWidth(input.defaultLabel) + target + 2;
  const controlsWidth = (density: ComposerControlDensity) =>
    estimateComposerControlsWidth(input.controls, density, gap);
  const fits = (floor: number, wasVisible: boolean) => {
    if (!input.current) return input.availableWidth >= floor;
    const margin = wasVisible ? -DENSITY_HYSTERESIS : DENSITY_HYSTERESIS;
    return input.availableWidth >= floor + margin;
  };
  const showTrigger = fits(
    controlsWidth("tight") + gap + target + 2,
    input.current?.showTrigger ?? true,
  );
  if (!showTrigger) return PHONE_QUICK_PROMPT_PRESENTATION;
  const showDefaultLabel =
    input.defaultLabel !== null &&
    fits(controlsWidth("tight") + gap + splitWidth, input.current?.showDefaultLabel ?? false);
  let width = showDefaultLabel ? splitWidth : target + 2;
  let visiblePinCount = 0;
  // Restore pins only after the other controls can show all their labels.
  for (const label of input.pinnedLabels.slice(0, 3)) {
    const nextWidth = width + gap + pillWidth(label);
    if (
      !fits(
        controlsWidth("full") + gap + nextWidth,
        visiblePinCount < (input.current?.visiblePinCount ?? 0),
      )
    )
      break;
    width = nextWidth;
    visiblePinCount++;
  }
  const availableControlsWidth = input.availableWidth - width - gap;
  const density = resolveDensityWithHysteresis(
    availableControlsWidth,
    input.current?.density,
    controlsWidth,
  );
  return { showTrigger, showDefaultLabel, visiblePinCount, width, density };
}

/** Inline feedback can wrap vertically but never grows beyond the toolbar's remaining width. */
export function resolveQuickPromptFeedbackWidth(
  interior: number,
  touch: boolean,
  controls: ComposerControlPresence,
): number {
  const gap = touch
    ? COMPOSER_TOOLBAR_GEOMETRY.touchControlGap
    : COMPOSER_TOOLBAR_GEOMETRY.controlGap;
  return Math.max(
    touch ? 44 : 28,
    Math.min(
      300,
      interior -
        estimateComposerFixedWidth(touch) -
        estimateComposerControlsWidth(controls, "tight", gap) -
        gap,
    ),
  );
}
