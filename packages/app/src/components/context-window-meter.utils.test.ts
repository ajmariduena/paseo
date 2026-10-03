import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_WARNING_PERCENTAGE,
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
