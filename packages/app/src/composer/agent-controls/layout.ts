import type { ContextWindowMeterRing } from "@/components/context-window-meter.utils";
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
  // Under touch density every control sits in a 44 slot: 28 + 16 matches the TouchTarget frames
  // of the attachment, ring and mic beside the clusters, and send/stop become a visible 32 circle.
  touchControlGap: 16,
  primaryTouchSize: 32,
  iconLabelGap: 4,
  labelPadding: 8,
  caretSize: 14,
  /** The intelligence pill draws a 1pt frame on both sides. */
  pillBorder: 2,
} as const;

/**
 * Every glyph on the toolbar row is stroked at the context ring's rendered width, whatever its
 * own size, so the row has one weight; the app's grid-unit stroke stays for everything else.
 */
export function resolveComposerToolbarGlyphStroke(ring: ContextWindowMeterRing): {
  strokeWidth: number;
  absoluteStrokeWidth: true;
} {
  return { strokeWidth: ring.strokeWidth, absoluteStrokeWidth: true };
}

const LUCIDE_GRID = 24;

/**
 * The Lucide box, in pt, that draws a glyph's ink exactly as tall as the ring: `inkExtent` is the
 * glyph's vertical span on the 24 grid before its stroke (a bookmark spans 18, a mic 20), and the
 * stroke renders at the ring's width whatever the box, so only the extent has to be scaled.
 */
export function resolveComposerToolbarGlyphBox(
  ring: ContextWindowMeterRing,
  inkExtent: number,
): number {
  return ((ring.size - ring.strokeWidth) * LUCIDE_GRID) / inkExtent;
}

export const COMPOSER_TOOLBAR_TOUCH_HIT_SLOP = {
  top: touchTargetOutset(COMPOSER_TOOLBAR_GEOMETRY.controlSize),
  bottom: touchTargetOutset(COMPOSER_TOOLBAR_GEOMETRY.controlSize),
  left: COMPOSER_TOOLBAR_GEOMETRY.touchControlGap / 2,
  right: COMPOSER_TOOLBAR_GEOMETRY.touchControlGap / 2,
} as const;

const DENSITY_HYSTERESIS = 12;
// Base-size text averages a little over 7px a glyph; budgeting 8 keeps every stage from
// overflowing into an ellipsis, which the toolbar must never show.
const LABEL_CHAR_WIDTH = 8;

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
  const { controlSize, iconLabelGap, labelPadding, caretSize, pillBorder } =
    COMPOSER_TOOLBAR_GEOMETRY;
  let width = controlSize + pillBorder;
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

export type ComposerLayoutMode = "lean" | "roomy";

/**
 * The widest toolbar interior that still gets the phone row on a touch device. An iPad mini in
 * portrait measures about 692pt; the same device in landscape beside the sidebar measures about
 * 760pt and keeps its labels.
 */
export const LEAN_COMPOSER_MAX_WIDTH = 720;
// Before the row is measured, the window minus the composer's margins and padding stands in.
const COMPOSER_WINDOW_INSET = 48;

/**
 * `lean` is the phone row — every control an icon, quick prompts behind one bookmark or the
 * attachment menu, the effort slider in an overlay. Compact layouts are always lean; a touch
 * device whose composer is narrow (an iPad in portrait, Split View or Slide Over) is lean by
 * measured width; a pointer never is, it walks the density ladder instead.
 */
export function resolveComposerLayoutMode(input: {
  compact: boolean;
  touch: boolean;
  /** The toolbar's measured interior, or 0 before the first layout. */
  interiorWidth: number;
  windowWidth: number;
}): ComposerLayoutMode {
  if (input.compact) return "lean";
  if (!input.touch) return "roomy";
  const width =
    input.interiorWidth > 0 ? input.interiorWidth : input.windowWidth - COMPOSER_WINDOW_INSET;
  return width <= LEAN_COMPOSER_MAX_WIDTH ? "lean" : "roomy";
}

export interface QuickPromptPresentation {
  /** False moves the picker into the attachment menu and the feedback above the input. */
  showTrigger: boolean;
  showDefaultLabel: boolean;
  width: number;
  density: ComposerControlDensity;
  /** The lean tablet row: one bookmark that sends the default on tap and opens on a long press. */
  tapSendsDefault: boolean;
}

const PHONE_QUICK_PROMPT_PRESENTATION: QuickPromptPresentation = {
  showTrigger: false,
  showDefaultLabel: false,
  width: 0,
  density: "icons",
  tapSendsDefault: false,
};

function leanQuickPromptPresentation(target: number): QuickPromptPresentation {
  return {
    showTrigger: true,
    showDefaultLabel: false,
    width: target + 2,
    density: "icons",
    tapSendsDefault: true,
  };
}

/** Touch clusters carry half a gap on each edge, so their controls sit in the same 44 slots. */
export function resolveComposerClusterInset(touch: boolean): number {
  return touch ? COMPOSER_TOOLBAR_GEOMETRY.touchControlGap : 0;
}

/** Attachment, context ring, mic and send/stop retain their complete target frames. */
export function estimateComposerFixedWidth(touch: boolean): number {
  return touch
    ? 4 * 44 + 2 * resolveComposerClusterInset(touch)
    : 4 * COMPOSER_TOOLBAR_GEOMETRY.controlSize + 5 * COMPOSER_TOOLBAR_GEOMETRY.controlGap;
}

// Base-size text runs wider than the toolbar's 7px estimate; the pill budgets 9px a glyph so a
// title that fits the budget never ellipsizes in the real control.
const QUICK_PROMPT_CHAR_WIDTH = 9;

/** The default prompt's pill at its full title; the toolbar drops the label rather than truncate it. */
export function estimateQuickPromptPillWidth(label: string, fontScale: number): number {
  const { controlSize, iconLabelGap, labelPadding } = COMPOSER_TOOLBAR_GEOMETRY;
  const chars = Array.from(label).length;
  return (
    controlSize +
    iconLabelGap +
    labelPadding +
    chars * QUICK_PROMPT_CHAR_WIDTH * normalizedFontScale(fontScale)
  );
}

/**
 * Resolve the joint budget: model/effort/mode labels disappear first, then the default prompt
 * label, and last the icon-only trigger itself. Both clusters consume this same decision, so a
 * prompt cannot keep the model at a density whose labels would overflow the remaining space.
 * Compact layouts are the phone row outright.
 */
export function resolveQuickPromptPresentation(input: {
  /** Button-row interior after the fixed attachment/ring/mic/send slots. */
  availableWidth: number;
  compact: boolean;
  /** The lean touch row on a tablet; compact wins when both are set. */
  lean?: boolean;
  touch: boolean;
  defaultLabel: string | null;
  controls: ComposerControlPresence;
  current?: QuickPromptPresentation;
}): QuickPromptPresentation {
  if (input.compact) return PHONE_QUICK_PROMPT_PRESENTATION;
  const gap = input.touch
    ? COMPOSER_TOOLBAR_GEOMETRY.touchControlGap
    : COMPOSER_TOOLBAR_GEOMETRY.controlGap;
  const target = input.touch ? 44 : 28;
  if (input.lean) return leanQuickPromptPresentation(target);
  const splitWidth =
    input.defaultLabel === null
      ? 0
      : estimateQuickPromptPillWidth(input.defaultLabel, input.controls.fontScale) + target + 2;
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
  const width = showDefaultLabel ? splitWidth : target + 2;
  const density = resolveDensityWithHysteresis(
    input.availableWidth - width - gap,
    input.current?.density,
    controlsWidth,
  );
  return { showTrigger, showDefaultLabel, width, density, tapSendsDefault: false };
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
