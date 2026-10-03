import { describe, expect, it } from "vitest";
import {
  COMPOSER_TOOLBAR_GEOMETRY,
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  resolveComposerToolbarGlyphSize,
} from "./layout";

describe("composer control layout", () => {
  it("removes labels in priority order as the toolbar narrows", () => {
    expect(resolveComposerControlPresentation("full")).toEqual({
      showCarets: true,
      showThinkingLabel: true,
      showModeLabel: true,
      aggregateFeatures: false,
    });
    expect(resolveComposerControlPresentation("condensed")).toEqual({
      showCarets: false,
      showThinkingLabel: false,
      showModeLabel: true,
      aggregateFeatures: true,
    });
    expect(resolveComposerControlPresentation("tight")).toEqual({
      showCarets: false,
      showThinkingLabel: false,
      showModeLabel: false,
      aggregateFeatures: true,
    });
  });

  it("uses local available width and hysteresis to avoid density churn", () => {
    const controls = {
      hasModel: true,
      hasThinking: true,
      hasMode: true,
      features: [{ type: "toggle" as const }],
      fontScale: 1,
    };

    expect(
      resolveComposerControlDensity({
        availableWidth: 420,
        currentDensity: "full",
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
        controls,
      }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({
        availableWidth: 380,
        currentDensity: "full",
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
        controls,
      }),
    ).toBe("condensed");
    expect(
      resolveComposerControlDensity({
        availableWidth: 290,
        currentDensity: "condensed",
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
        controls,
      }),
    ).toBe("condensed");
    expect(
      resolveComposerControlDensity({
        availableWidth: 280,
        currentDensity: "condensed",
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
        controls,
      }),
    ).toBe("tight");
    expect(
      resolveComposerControlDensity({
        availableWidth: 300,
        currentDensity: "tight",
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
        controls,
      }),
    ).toBe("tight");
    expect(
      resolveComposerControlDensity({
        availableWidth: 312,
        currentDensity: "tight",
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
        controls,
      }),
    ).toBe("condensed");
  });

  it("budgets extra features and larger text before restoring full labels", () => {
    const base = {
      availableWidth: 430,
      currentDensity: "condensed" as const,
      controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
    };

    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          hasModel: true,
          hasThinking: true,
          hasMode: true,
          features: [{ type: "toggle" }],
          fontScale: 1,
        },
      }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          hasModel: true,
          hasThinking: true,
          hasMode: true,
          features: [{ type: "toggle" }, { type: "select", label: "Tools" }],
          fontScale: 1,
        },
      }),
    ).toBe("condensed");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          hasModel: true,
          hasThinking: true,
          hasMode: true,
          features: [{ type: "toggle" }],
          fontScale: 1.25,
        },
      }),
    ).toBe("condensed");
  });

  it("condenses before a labeled feature would overflow", () => {
    const base = {
      availableWidth: 430,
      currentDensity: "full" as const,
      controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap,
      controls: {
        hasModel: true,
        hasThinking: true,
        hasMode: true,
        fontScale: 1,
      },
    };

    expect(
      resolveComposerControlDensity({
        ...base,
        controls: { ...base.controls, features: [{ type: "toggle" }] },
      }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          ...base.controls,
          features: [{ type: "select", label: "A much longer localized feature label" }],
        },
      }),
    ).toBe("condensed");
  });

  it("condenses earlier when touch spacing widens the gaps between controls", () => {
    const input = {
      availableWidth: 420,
      currentDensity: "full" as const,
      controls: {
        hasModel: true,
        hasThinking: true,
        hasMode: true,
        features: [{ type: "toggle" as const }],
        fontScale: 1,
      },
    };

    expect(
      resolveComposerControlDensity({ ...input, controlGap: COMPOSER_TOOLBAR_GEOMETRY.controlGap }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({
        ...input,
        controlGap: COMPOSER_TOOLBAR_GEOMETRY.touchControlGap,
      }),
    ).toBe("condensed");
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
