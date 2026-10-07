import { describe, expect, it } from "vitest";
import {
  resolveQuickPromptPresentation,
  resolveQuickPromptFeedbackWidth,
  COMPOSER_CONTROL_DENSITIES,
  estimateComposerFixedWidth,
  COMPOSER_TOOLBAR_GEOMETRY,
  estimateComposerControlsWidth,
  estimateModelPillWidth,
  estimateQuickPromptPillWidth,
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  resolveComposerToolbarGlyphSize,
  resolveIntelligenceTriggerKind,
  resolveComposerLayoutMode,
  LEAN_COMPOSER_MAX_WIDTH,
  type ComposerControlPresence,
  resolveComposerToolbarGlyphBox,
  resolveComposerToolbarGlyphStroke,
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
  it("gives things up in order: effort suffix, mode label, carets, model label, quick prompts", () => {
    expect(resolveComposerControlPresentation("full")).toEqual({
      showCarets: true,
      showEffortSuffix: true,
      showModeLabel: true,
      showModelLabel: true,
      aggregateFeatures: false,
      showQuickPromptTrigger: true,
    });
    expect(resolveComposerControlPresentation("condensed")).toEqual({
      showCarets: false,
      showEffortSuffix: false,
      showModeLabel: false,
      showModelLabel: true,
      aggregateFeatures: true,
      showQuickPromptTrigger: true,
    });
    expect(resolveComposerControlPresentation("tight")).toEqual({
      showCarets: false,
      showEffortSuffix: false,
      showModeLabel: false,
      showModelLabel: false,
      aggregateFeatures: true,
      showQuickPromptTrigger: true,
    });
    expect(resolveComposerControlPresentation("icons")).toEqual({
      showCarets: false,
      showEffortSuffix: false,
      showModeLabel: false,
      showModelLabel: false,
      aggregateFeatures: true,
      showQuickPromptTrigger: false,
    });
  });

  it("shows the gauge exactly when the model label is gone", () => {
    expect(
      COMPOSER_CONTROL_DENSITIES.map((density) =>
        resolveIntelligenceTriggerKind(resolveComposerControlPresentation(density)),
      ),
    ).toEqual(["pill", "pill", "pill", "pill", "gauge", "gauge"]);
  });

  it("keeps extra features off the toolbar once the trigger owns an Advanced page", () => {
    const gap = COMPOSER_TOOLBAR_GEOMETRY.controlGap;
    const withFeature = estimateComposerControlsWidth(CLAUDE_CONTROLS, "tight", gap);
    const withoutFeature = estimateComposerControlsWidth(
      { ...CLAUDE_CONTROLS, features: [] },
      "tight",
      gap,
    );
    expect(withFeature).toBe(withoutFeature);
    // Without a trigger the badge stands in: the same slot, minus the pill's frame.
    expect(
      estimateComposerControlsWidth({ ...CLAUDE_CONTROLS, hasModel: false }, "tight", gap),
    ).toBe(withoutFeature - COMPOSER_TOOLBAR_GEOMETRY.pillBorder);
    expect(estimateComposerControlsWidth(CLAUDE_CONTROLS, "icons", gap)).toBe(withFeature);
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
    expect(tight).toBe(
      COMPOSER_TOOLBAR_GEOMETRY.controlSize + COMPOSER_TOOLBAR_GEOMETRY.pillBorder,
    );
    expect(
      estimateModelPillWidth(
        { ...CLAUDE_CONTROLS, hasEffort: false },
        resolveComposerControlPresentation("full"),
      ),
    ).toBeLessThan(full);
  });

  it("drops the effort suffix before a long level name could truncate the mode label", () => {
    // iPad mini portrait, sidebar closed: 692pt interior minus the fixed targets and the
    // "Resumen corto" split, with touch gaps.
    const controls = {
      ...CLAUDE_CONTROLS,
      features: [],
      modelLabel: "Sonnet 5",
      effortLabel: "Ultra code",
      modeLabel: "Always ask",
    };
    const gap = COMPOSER_TOOLBAR_GEOMETRY.touchControlGap;
    const availableWidth =
      692 -
      estimateComposerFixedWidth(true) -
      (estimateQuickPromptPillWidth("Resumen corto", 1) + 44 + 2) -
      gap;
    expect(estimateComposerControlsWidth(controls, "full", gap)).toBeGreaterThan(availableWidth);
    const density = resolveComposerControlDensity({
      availableWidth,
      currentDensity: "full",
      controls,
      controlGap: gap,
    });
    expect(density).toBe("no-effort");
    expect(resolveComposerControlPresentation(density)).toMatchObject({
      showModeLabel: true,
      showEffortSuffix: false,
    });
    expect(estimateComposerControlsWidth(controls, density, gap)).toBeLessThanOrEqual(
      availableWidth,
    );
    expect(
      resolveComposerControlDensity({
        availableWidth,
        currentDensity: "full",
        controls: { ...controls, effortLabel: "Extra high" },
        controlGap: gap,
      }),
    ).toBe("no-effort");
  });

  it("fits the iPad mini portrait composer with the sidebar open without overflowing", () => {
    // 368pt interior minus the +, context ring, mic and stop slots and the clusters' insets.
    // With every touch control in a 44 slot the mode label no longer fits beside the pill.
    const availableWidth = 368 - estimateComposerFixedWidth(true);
    const gap = COMPOSER_TOOLBAR_GEOMETRY.touchControlGap;
    const density = resolveComposerControlDensity({
      availableWidth,
      currentDensity: "full",
      controls: CLAUDE_CONTROLS,
      controlGap: gap,
    });
    expect(density).toBe("condensed");
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
      { showModelLabel: false, showQuickPromptTrigger: false },
    ]);
  });

  it("bottoms out at icons when even the glyph-only row cannot fit", () => {
    expect(
      resolveComposerControlDensity({
        availableWidth: 40,
        currentDensity: "tight",
        controls: CLAUDE_CONTROLS,
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
      }),
    ).toBe("icons");
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
      touchControlGap: 16,
      primaryTouchSize: 32,
      iconLabelGap: 4,
      labelPadding: 8,
      caretSize: 14,
      pillBorder: 2,
    });
    expect(resolveComposerToolbarGlyphSize("web")).toBe(16);
    expect(resolveComposerToolbarGlyphSize("native")).toBe(20);
  });
});

describe("quick prompt capacity", () => {
  const base = {
    compact: false,
    touch: true,
    shortcutLabel: "Summary",
    controls: CLAUDE_CONTROLS,
  };
  it("drops the shortcut label to the glyph when it cannot fit", () => {
    expect(resolveQuickPromptPresentation({ ...base, availableWidth: 400 })).toMatchObject({
      showShortcutLabel: true,
    });
    expect(resolveQuickPromptPresentation({ ...base, availableWidth: 200 })).toMatchObject({
      showTrigger: true,
      showShortcutLabel: false,
    });
  });
  it("reserves the shortcut label until the model pill has collapsed to its glyph", () => {
    const result = resolveQuickPromptPresentation({ ...base, availableWidth: 260 });
    expect(result).toMatchObject({ showShortcutLabel: true, density: "tight" });
    expect(resolveComposerControlPresentation(result.density).showModelLabel).toBe(false);
    const narrower = resolveQuickPromptPresentation({ ...base, availableWidth: 200 });
    expect(narrower.showShortcutLabel).toBe(false);
  });

  it("drops the icon-only trigger into the attachment menu as the last stage", () => {
    // Mode icon + gauge + a 44pt bookmark with touch gaps.
    const gap = COMPOSER_TOOLBAR_GEOMETRY.touchControlGap;
    const floor = estimateComposerControlsWidth(CLAUDE_CONTROLS, "tight", gap) + gap + 46;
    const withTrigger = resolveQuickPromptPresentation({ ...base, availableWidth: floor });
    expect(withTrigger).toMatchObject({ showTrigger: true, density: "tight", width: 46 });
    const phoneRow = resolveQuickPromptPresentation({ ...base, availableWidth: floor - 1 });
    expect(phoneRow).toEqual({
      showTrigger: false,
      showShortcutLabel: false,
      width: 0,
      density: "icons",
      leanShortcut: false,
    });
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: floor + 11, current: phoneRow })
        .showTrigger,
    ).toBe(false);
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: floor + 13, current: phoneRow })
        .showTrigger,
    ).toBe(true);
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: floor - 11, current: withTrigger })
        .showTrigger,
    ).toBe(true);
  });

  it("is always the phone row on compact layouts", () => {
    expect(
      resolveQuickPromptPresentation({ ...base, compact: true, availableWidth: 1000 }),
    ).toEqual({
      showTrigger: false,
      showShortcutLabel: false,
      width: 0,
      density: "icons",
      leanShortcut: false,
    });
  });

  it("gives the lean tablet row one bookmark that sends on tap", () => {
    expect(resolveQuickPromptPresentation({ ...base, lean: true, availableWidth: 1000 })).toEqual({
      showTrigger: true,
      showShortcutLabel: false,
      width: 46,
      density: "icons",
      leanShortcut: true,
    });
    expect(
      resolveQuickPromptPresentation({ ...base, compact: true, lean: true, availableWidth: 1000 })
        .showTrigger,
    ).toBe(false);
  });

  it("keeps quick prompt labels stable across resize noise and restores after 12px", () => {
    // Mode icon + gauge + the "Summary" split with touch gaps.
    const gap = COMPOSER_TOOLBAR_GEOMETRY.touchControlGap;
    const floor =
      estimateComposerControlsWidth(CLAUDE_CONTROLS, "tight", gap) +
      gap +
      estimateQuickPromptPillWidth("Summary", 1) +
      44 +
      2;
    const wide = resolveQuickPromptPresentation({ ...base, availableWidth: floor + 6 });
    expect(wide.showShortcutLabel).toBe(true);
    const jitter = resolveQuickPromptPresentation({
      ...base,
      availableWidth: floor - 1,
      current: wide,
    });
    expect(jitter.showShortcutLabel).toBe(true);
    expect(jitter.density).toBe(wide.density);
    const narrow = resolveQuickPromptPresentation({
      ...base,
      availableWidth: floor - 13,
      current: jitter,
    });
    expect(narrow.showShortcutLabel).toBe(false);
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: floor + 11, current: narrow })
        .showShortcutLabel,
    ).toBe(false);
    expect(
      resolveQuickPromptPresentation({ ...base, availableWidth: floor + 13, current: narrow })
        .showShortcutLabel,
    ).toBe(true);
  });

  it("budgets inline feedback inside the 368px touch toolbar", () => {
    const width = resolveQuickPromptFeedbackWidth(368, true, base.controls);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(
      width +
        estimateComposerFixedWidth(true) +
        estimateComposerControlsWidth(
          base.controls,
          "tight",
          COMPOSER_TOOLBAR_GEOMETRY.touchControlGap,
        ) +
        COMPOSER_TOOLBAR_GEOMETRY.touchControlGap,
    ).toBeLessThanOrEqual(368);
  });

  it("compact and absent shortcut always open picker; larger text consumes capacity", () => {
    expect(
      resolveQuickPromptPresentation({ ...base, compact: true, availableWidth: 400 })
        .showShortcutLabel,
    ).toBe(false);
    expect(
      resolveQuickPromptPresentation({ ...base, shortcutLabel: null, availableWidth: 400 })
        .showShortcutLabel,
    ).toBe(false);
    expect(
      resolveQuickPromptPresentation({
        ...base,
        availableWidth: 250,
        controls: { ...base.controls, fontScale: 2 },
      }),
    ).toMatchObject({ showTrigger: true, showShortcutLabel: false });
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
        shortcutLabel: "Resumen corto",
        availableWidth: interior - fixed,
      });
      const gap = COMPOSER_TOOLBAR_GEOMETRY.touchControlGap;
      expect(
        fixed + result.width + gap + estimateComposerControlsWidth(controls, result.density, gap),
      ).toBeLessThanOrEqual(interior);
    }
  });

  it("budgets the full title at base-size glyph widths so the label never ellipsizes", () => {
    // Glyph slot, its gap, label padding, then 9px a character.
    expect(estimateQuickPromptPillWidth("Resumen corto", 1)).toBe(28 + 4 + 8 + 13 * 9);
    expect(estimateQuickPromptPillWidth("A title longer than fourteen", 1)).toBe(
      28 + 4 + 8 + 28 * 9,
    );
    expect(estimateQuickPromptPillWidth("Tests", 2)).toBe(28 + 4 + 8 + 5 * 9 * 2);
  });
});

describe("composer layout mode", () => {
  it("is lean on compact, and on a touch device whose composer is narrow", () => {
    expect(
      resolveComposerLayoutMode({
        compact: true,
        touch: false,
        interiorWidth: 1200,
        windowWidth: 1400,
      }),
    ).toBe("lean");
    // iPad mini portrait, sidebar closed.
    expect(
      resolveComposerLayoutMode({
        compact: false,
        touch: true,
        interiorWidth: 692,
        windowWidth: 744,
      }),
    ).toBe("lean");
    expect(
      resolveComposerLayoutMode({
        compact: false,
        touch: true,
        interiorWidth: LEAN_COMPOSER_MAX_WIDTH + 1,
        windowWidth: 1133,
      }),
    ).toBe("roomy");
    // iPad mini landscape beside the sidebar.
    expect(
      resolveComposerLayoutMode({
        compact: false,
        touch: true,
        interiorWidth: 761,
        windowWidth: 1133,
      }),
    ).toBe("roomy");
  });

  it("never leans with a pointer, and guesses from the window before the row is measured", () => {
    expect(
      resolveComposerLayoutMode({
        compact: false,
        touch: false,
        interiorWidth: 500,
        windowWidth: 600,
      }),
    ).toBe("roomy");
    expect(
      resolveComposerLayoutMode({
        compact: false,
        touch: true,
        interiorWidth: 0,
        windowWidth: 744,
      }),
    ).toBe("lean");
    expect(
      resolveComposerLayoutMode({
        compact: false,
        touch: true,
        interiorWidth: 0,
        windowWidth: 1133,
      }),
    ).toBe("roomy");
  });
});

describe("resolveComposerToolbarGlyphStroke", () => {
  it("strokes toolbar glyphs at the ring's rendered width regardless of glyph size", () => {
    expect(resolveComposerToolbarGlyphStroke({ size: 20, strokeWidth: 2 })).toEqual({
      strokeWidth: 2,
      absoluteStrokeWidth: true,
    });
    expect(resolveComposerToolbarGlyphStroke({ size: 16, strokeWidth: 2 }).strokeWidth).toBe(2);
  });
});

describe("resolveComposerToolbarGlyphBox", () => {
  it("sizes a glyph so its stroked ink is exactly the ring's height", () => {
    const ring = { size: 20, strokeWidth: 2 };
    expect(resolveComposerToolbarGlyphBox(ring, 18)).toBe(24);
    expect(resolveComposerToolbarGlyphBox(ring, 20)).toBeCloseTo(21.6, 6);
    const inkHeight = (extent: number) =>
      (extent * resolveComposerToolbarGlyphBox(ring, extent)) / 24 + ring.strokeWidth;
    expect(inkHeight(18)).toBeCloseTo(20, 6);
    expect(inkHeight(14)).toBeCloseTo(20, 6);
  });
});
