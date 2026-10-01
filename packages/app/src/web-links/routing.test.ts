import { describe, expect, it } from "vitest";
import {
  isAlternateWebLinkChord,
  readWebLinkModifiers,
  resolveWebLinkDestination,
} from "./routing";

describe("isAlternateWebLinkChord", () => {
  it("uses Shift+Cmd on macOS and Shift+Ctrl elsewhere", () => {
    expect(isAlternateWebLinkChord({ shiftKey: true, metaKey: true }, true)).toBe(true);
    expect(isAlternateWebLinkChord({ shiftKey: true, ctrlKey: true }, true)).toBe(false);
    expect(isAlternateWebLinkChord({ shiftKey: true, ctrlKey: true }, false)).toBe(true);
    expect(isAlternateWebLinkChord({ shiftKey: true, metaKey: true }, false)).toBe(false);
  });

  it("requires Shift", () => {
    expect(isAlternateWebLinkChord({ metaKey: true }, true)).toBe(false);
    expect(isAlternateWebLinkChord(undefined, true)).toBe(false);
  });
});

describe("resolveWebLinkDestination", () => {
  it("follows the saved behavior on a plain click", () => {
    for (const behavior of ["ask", "in-app", "external"] as const) {
      expect(
        resolveWebLinkDestination({ behavior, invertModifier: true, alternateChord: false }),
      ).toBe(behavior);
    }
  });

  it("ignores the chord when inverting is off", () => {
    expect(
      resolveWebLinkDestination({
        behavior: "external",
        invertModifier: false,
        alternateChord: true,
      }),
    ).toBe("external");
  });

  it("inverts a saved destination with the chord", () => {
    expect(
      resolveWebLinkDestination({ behavior: "in-app", invertModifier: true, alternateChord: true }),
    ).toBe("external");
    expect(
      resolveWebLinkDestination({
        behavior: "external",
        invertModifier: true,
        alternateChord: true,
      }),
    ).toBe("in-app");
  });

  it("skips the prompt and opens in Paseo when asking", () => {
    expect(
      resolveWebLinkDestination({ behavior: "ask", invertModifier: true, alternateChord: true }),
    ).toBe("in-app");
  });
});

describe("readWebLinkModifiers", () => {
  it("reads modifiers from a press event's DOM event", () => {
    expect(readWebLinkModifiers({ nativeEvent: { shiftKey: true, metaKey: true } })).toEqual({
      shiftKey: true,
      metaKey: true,
      ctrlKey: false,
    });
  });

  it("reads modifiers from a DOM event", () => {
    expect(readWebLinkModifiers({ shiftKey: false, ctrlKey: true })).toEqual({
      shiftKey: false,
      metaKey: false,
      ctrlKey: true,
    });
  });

  it("returns nothing without an event", () => {
    expect(readWebLinkModifiers(undefined)).toBeUndefined();
  });
});
