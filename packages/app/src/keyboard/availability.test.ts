import { describe, expect, it } from "vitest";
import { keyboardShortcutsAvailable } from "./availability";

describe("keyboardShortcutsAvailable", () => {
  it("matches the environments where the shortcut dispatcher runs", () => {
    expect(
      keyboardShortcutsAvailable({ isNative: false, isCompact: false, hasHardwareKeyboard: false }),
    ).toBe(true);
    expect(
      keyboardShortcutsAvailable({ isNative: false, isCompact: true, hasHardwareKeyboard: false }),
    ).toBe(false);
    expect(
      keyboardShortcutsAvailable({ isNative: true, isCompact: false, hasHardwareKeyboard: false }),
    ).toBe(false);
    expect(
      keyboardShortcutsAvailable({ isNative: true, isCompact: true, hasHardwareKeyboard: false }),
    ).toBe(false);
  });

  it("turns on for a regular-width iPad with a hardware keyboard attached", () => {
    expect(
      keyboardShortcutsAvailable({ isNative: true, isCompact: false, hasHardwareKeyboard: true }),
    ).toBe(true);
    expect(
      keyboardShortcutsAvailable({ isNative: true, isCompact: true, hasHardwareKeyboard: true }),
    ).toBe(false);
  });
});
