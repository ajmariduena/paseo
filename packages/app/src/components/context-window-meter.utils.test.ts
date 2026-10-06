import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_WARNING_PERCENTAGE,
  resolveContextWindowMeterGlyphSize,
  resolveContextWindowMeterRing,
  resolveContextWindowTone,
} from "@/components/context-window-meter.utils";

describe("context window tone", () => {
  it("turns amber from 75%", () => {
    expect(CONTEXT_WINDOW_WARNING_PERCENTAGE).toBe(75);
    expect(resolveContextWindowTone(0)).toBe("normal");
    expect(resolveContextWindowTone(74.9)).toBe("normal");
    expect(resolveContextWindowTone(75)).toBe("warning");
    expect(resolveContextWindowTone(82)).toBe("warning");
    expect(resolveContextWindowTone(90)).toBe("warning");
  });

  it("turns red above 90%", () => {
    expect(resolveContextWindowTone(90.1)).toBe("danger");
    expect(resolveContextWindowTone(100)).toBe("danger");
  });
});

describe("toolbar ring", () => {
  it("draws the same 20pt ring on a phone row as on a tablet row", () => {
    expect(resolveContextWindowMeterGlyphSize("native")).toBe(20);
    expect(resolveContextWindowMeterGlyphSize("web")).toBe(16);
  });

  it("strokes the ring as a Lucide glyph of the same size renders under the app stroke", () => {
    expect(resolveContextWindowMeterRing(20)).toEqual({ size: 20, strokeWidth: 1.25 });
    expect(resolveContextWindowMeterRing(16)).toEqual({ size: 16, strokeWidth: 1 });
  });

  it("keeps the standalone meter at 14pt with a 2pt stroke", () => {
    expect(resolveContextWindowMeterRing()).toEqual({ size: 14, strokeWidth: 2 });
  });
});
