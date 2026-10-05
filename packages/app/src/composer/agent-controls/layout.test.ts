import { describe, expect, it } from "vitest";
import {
  resolveQuickPromptPresentation,
  resolveQuickPromptFeedbackWidth,
  COMPOSER_CONTROL_DENSITIES,
  estimateComposerFixedWidth,
  COMPOSER_TOOLBAR_GEOMETRY,
  estimateComposerControlsWidth,
  estimateModelPillWidth,
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  resolveComposerToolbarGlyphSize,
  type ComposerControlPresence,
} from "./layout";

const CLAUDE_CONTROLS: ComposerControlPresence = {
  hasModel: true,
  hasEffort: true,
  hasMode: true,
  features: [{ type: "toggle" }],
  fontScale: 1,
  modelLabel: "Opus 5.5",
  effortLabel: "Medium",
  modeLabel: "Bypass",
};

describe("composer control layout", () => {
  it("gives things up in order: effort suffix, mode label, carets, then the model label", () => {
    expect(resolveComposerControlPresentation("full")).toEqual({
      showCarets: true,
      showEffortSuffix: true,
      showModeLabel: true,
      showModelLabel: true,
      aggregateFeatures: false,
    });
    expect(resolveComposerControlPresentation("condensed")).toEqual({
      showCarets: false,
      showEffortSuffix: false,
      showModeLabel: false,
      showModelLabel: true,
      aggregateFeatures: true,
    });
    expect(resolveComposerControlPresentation("tight")).toEqual({
      showCarets: false,
      showEffortSuffix: false,
      showModeLabel: false,
      showModelLabel: false,
      aggregateFeatures: true,
    });
  });

  it("shrinks the pill from model · effort ▾ down to the provider glyph alone", () => {
    const full = estimateModelPillWidth(
      CLAUDE_CONTROLS,
      resolveComposerControlPresentation("full"),
    );
    const condensed = estimateModelPillWidth(
      CLAUDE_CONTROLS,
      resolveComposerControlPresentation("condensed"),
    );
    const tight = estimateModelPillWidth(
      CLAUDE_CONTROLS,
      resolveComposerControlPresentation("tight"),
    );
    expect(full).toBeGreaterThan(condensed);
    expect(condensed).toBeGreaterThan(tight);
    expect(tight).toBe(COMPOSER_TOOLBAR_GEOMETRY.controlSize);
    expect(
      estimateModelPillWidth(
        { ...CLAUDE_CONTROLS, hasEffort: false },
        resolveComposerControlPresentation("full"),
      ),
    ).toBeLessThan(full);
  });

  it("fits the iPad mini portrait composer with the sidebar open without overflowing", () => {
    // 368pt interior minus +, context ring, mic, stop and their touch gaps.
    const availableWidth = 368 - 28 - 12 - 28 - 28 - 32 - 12;
    const gap = COMPOSER_TOOLBAR_GEOMETRY.touchControlGap;
    const density = resolveComposerControlDensity({
      availableWidth,
      currentDensity: "full",
      controls: CLAUDE_CONTROLS,
      controlGap: gap,
    });
    expect(density).toBe("no-mode");
    expect(estimateComposerControlsWidth(CLAUDE_CONTROLS, density, gap)).toBeLessThanOrEqual(
      availableWidth,
    );
  });

  it("collapses one stage at a time with a 12px dead band in both directions", () => {
    const gap = COMPOSER_TOOLBAR_GEOMETRY.controlGap;
    const stages = COMPOSER_CONTROL_DENSITIES;
    for (let i = 0; i < stages.length - 1; i++) {
      const richer = stages[i];
      const narrower = stages[i + 1];
      const floor = estimateComposerControlsWidth(CLAUDE_CONTROLS, richer, gap);
      const resolve = (availableWidth: number, currentDensity: typeof richer) =>
        resolveComposerControlDensity({
          availableWidth,
          currentDensity,
          controlGap: gap,
          controls: CLAUDE_CONTROLS,
        });
      expect(resolve(floor - 11, richer)).toBe(richer);
      expect(resolve(floor - 13, richer)).toBe(narrower);
      expect(resolve(floor + 11, narrower)).toBe(narrower);
      expect(resolve(floor + 13, narrower)).toBe(richer);
    }
    expect(stages.map((stage) => resolveComposerControlPresentation(stage))).toMatchObject([
      { showEffortSuffix: true, showModeLabel: true, showCarets: true, showModelLabel: true },
      { showEffortSuffix: false, showModeLabel: true, showCarets: true, showModelLabel: true },
      { showEffortSuffix: false, showModeLabel: false, showCarets: true, showModelLabel: true },
      { showEffortSuffix: false, showModeLabel: false, showCarets: false, showModelLabel: true },
      { showEffortSuffix: false, showModeLabel: false, showCarets: false, showModelLabel: false },
    ]);
  });

  it("budgets extra features and larger text before restoring full labels", () => {
    const gap = COMPOSER_TOOLBAR_GEOMETRY.controlGap;
    const availableWidth = estimateComposerControlsWidth(CLAUDE_CONTROLS, "full", gap) + 20;
    const base = { availableWidth, currentDensity: "condensed" as const, controlGap: gap };

    expect(resolveComposerControlDensity({ ...base, controls: CLAUDE_CONTROLS })).toBe("full");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          ...CLAUDE_CONTROLS,
          features: [{ type: "toggle" }, { type: "select", label: "Tools" }],
        },
      }),
    ).toBe("no-effort");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: { ...CLAUDE_CONTROLS, fontScale: 1.25 },
      }),
    ).toBe("no-effort");
  });

  it("condenses before a labeled feature would overflow", () => {
    const gap = COMPOSER_TOOLBAR_GEOMETRY.controlGap;
    const base = {
      availableWidth: estimateComposerControlsWidth(CLAUDE_CONTROLS, "full", gap) + 20,
      currentDensity: "full" as const,
      controlGap: gap,
    };

    expect(resolveComposerControlDensity({ ...base, controls: CLAUDE_CONTROLS })).toBe("full");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          ...CLAUDE_CONTROLS,
          features: [{ type: "select", label: "A much longer localized feature label" }],
        },
      }),
    ).toBe("no-effort");
  });

  it("condenses earlier when touch spacing widens the gaps between controls", () => {
    const availableWidth =
      estimateComposerControlsWidth(CLAUDE_CONTROLS, "full", COMPOSER_TOOLBAR_GEOMETRY.controlGap) +
      2;
    const input = { availableWidth, currentDensity: "full" as const, controls: CLAUDE_CONTROLS };

    expect(
      resolveComposerControlDensity({ ...input, controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({
        ...input,
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.touchControlGap,
      }),
    ).toBe("no-effort");
  });

  it("gives every toolbar control one shell and one platform glyph envelope", () => {
    expect(COMPOSER_TOOLBAR_GEOMETRY).toEqual({
      controlSize: 28,
      controlGap: 4,
      touchControlGap: 12,
      primaryTouchSize: 32,
      iconLabelGap: 4,
      labelPadding: 8,
      caretSize: 14,
    });
    expect(resolveComposerToolbarGlyphSize("web")).toBe(16);
    expect(resolveComposerToolbarGlyphSize("native")).toBe(20);
  });
});

describe("quick prompt capacity", () => {
  const base = {
    compact: false,
    touch: true,
    defaultLabel: "Summary",
    pinnedLabels: ["Tests", "Commit", "Review"],
    controls: CLAUDE_CONTROLS,
  };
  it("keeps at most three pins and removes them before the default label", () => {
    expect(resolveQuickPromptPresentation({ ...base, availableWidth: 1000 })).toMatchObject({
      showDefaultLabel: true,
      visiblePinCount: 3,
    });
    expect(resolveQuickPromptPresentation({ ...base, availableWidth: 400 })).toMatchObject({
      showDefaultLabel: true,
      visiblePinCount: 0,
    });
    expect(resolveQuickPromptPresentation({ ...base, availableWidth: 240 })).toMatchObject({
      showDefaultLabel: false,
      visiblePinCount: 0,
    });
  });
  it("reserves the default label until the model pill has collapsed to its glyph", () => {
    const result = resolveQuickPromptPresentation({ ...base, availableWidth: 260 });
    expect(result).toMatchObject({ showDefaultLabel: true, visiblePinCount: 0, density: "tight" });
    expect(resolveComposerControlPresentation(result.density).showModelLabel).toBe(false);
    const narrower = resolveQuickPromptPresentation({ ...base, availableWidth: 240 });
    expect(narrower.showDefaultLabel).toBe(false);
  });

  it.each([true, false])(
    "fits all controls into the 368px iPad mini interior (touch=%s)",
    (touch) => {
      const gap = touch
        ? COMPOSER_TOOLBAR_GEOMETRY.touchControlGap
        : COMPOSER_TOOLBAR_GEOMETRY.controlGap;
      const fixed = estimateComposerFixedWidth(touch);
      const result = resolveQuickPromptPresentation({
        ...base,
        touch,
        availableWidth: 368 - fixed,
      });
      const occupied =
        fixed +
        result.width +
        gap +
        estimateComposerControlsWidth(base.controls, result.density, gap);
      expect(occupied).toBeLessThanOrEqual(368);
      expect(result.visiblePinCount).toBe(0);
    },
  );

  it.each([1, 1.5, 2])("fits longer localized labels at font scale %s", (fontScale) => {
    const controls = {
      ...CLAUDE_CONTROLS,
      fontScale,
      modelLabel: "GPT-6 Astra",
      effortLabel: "Extra high",
      modeLabel: "Ask before edits",
    };
    for (const interior of [368, 420, 600, 1000]) {
      const fixed = estimateComposerFixedWidth(true);
      const result = resolveQuickPromptPresentation({
        ...base,
        controls,
        defaultLabel: "Resumen corto",
        availableWidth: interior - fixed,
      });
      expect(
        fixed + result.width + 12 + estimateComposerControlsWidth(controls, result.density, 12),
      ).toBeLessThanOrEqual(interior);
    }
  });

  it("keeps quick prompt labels stable across resize noise and restores after 12px", () => {
    const wide = resolveQuickPromptPresentation({ ...base, availableWidth: 260 });
    expect(wide.showDefaultLabel).toBe(true);
    const jitter = resolveQuickPromptPresentation({ ...base, availableWidth: 253, current: wide });
    expect(jitter.showDefaultLabel).toBe(true);
    expect(jitter.density).toBe(wide.density);
    const narrow = resolveQuickPromptPresentation({
      ...base,
      availableWidth: 244,
      current: jitter,
    });
    expect(narrow.showDefaultLabel).toBe(false);
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: 265, current: narrow })
        .showDefaultLabel,
    ).toBe(false);
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: 275, current: narrow })
        .showDefaultLabel,
    ).toBe(true);
  });

  it("keeps pins through the same dead band", () => {
    const wide = resolveQuickPromptPresentation({ ...base, availableWidth: 540 });
    expect(wide.visiblePinCount).toBe(1);
    const jitter = resolveQuickPromptPresentation({ ...base, availableWidth: 530, current: wide });
    expect(jitter.visiblePinCount).toBe(1);
    const narrow = resolveQuickPromptPresentation({
      ...base,
      availableWidth: 520,
      current: jitter,
    });
    expect(narrow.visiblePinCount).toBe(0);
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: 540, current: narrow })
        .visiblePinCount,
    ).toBe(0);
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: 550, current: narrow })
        .visiblePinCount,
    ).toBe(1);
  });

  it("budgets inline feedback inside the 368px touch toolbar", () => {
    const width = resolveQuickPromptFeedbackWidth(368, true, base.controls);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(
      width +
        estimateComposerFixedWidth(true) +
        estimateComposerControlsWidth(base.controls, "tight", 12) +
        12,
    ).toBeLessThanOrEqual(368);
  });

  it("compact and absent default always open picker; larger text consumes capacity", () => {
    expect(
      resolveQuickPromptPresentation({ ...base, compact: true, availableWidth: 400 })
        .showDefaultLabel,
    ).toBe(false);
    expect(
      resolveQuickPromptPresentation({ ...base, defaultLabel: null, availableWidth: 400 })
        .showDefaultLabel,
    ).toBe(false);
    expect(
      resolveQuickPromptPresentation({
        ...base,
        availableWidth: 300,
        controls: { ...base.controls, fontScale: 2 },
      }),
    ).toMatchObject({ showDefaultLabel: false, visiblePinCount: 0 });
  });
});
