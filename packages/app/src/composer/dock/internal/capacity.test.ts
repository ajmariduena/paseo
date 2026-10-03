import { describe, expect, it } from "vitest";
import { CENTERED_KEYBOARD_GAP, resolveComposerCapacity, updateComposerCapacity } from "./capacity";

describe("composer viewport", () => {
  it("preserves the editing capacity when the keyboard closes", () => {
    const viewport = { height: 582, bottomInset: 24, centered: false, safeAreaBottom: 0 };
    const open = updateComposerCapacity(undefined, { ...viewport, keyboardShift: 308 });
    const closed = updateComposerCapacity(open, { ...viewport, keyboardShift: 0 });
    expect(open.capacity).toBe(245);
    expect(closed.capacity).toBe(open.capacity);
    expect(updateComposerCapacity(closed, { ...viewport, keyboardShift: 250 }).capacity).toBe(303);
  });

  it("remeasures the viewport without forgetting the keyboard reservation", () => {
    const open = updateComposerCapacity(undefined, {
      height: 582,
      bottomInset: 24,
      centered: false,
      safeAreaBottom: 0,
      keyboardShift: 308,
    });
    expect(
      updateComposerCapacity(open, {
        height: 650,
        bottomInset: 24,
        centered: false,
        safeAreaBottom: 0,
        keyboardShift: 0,
      }).capacity,
    ).toBe(313);
    expect(
      updateComposerCapacity(open, {
        height: 0,
        bottomInset: 24,
        centered: false,
        safeAreaBottom: 0,
        keyboardShift: 0,
      }),
    ).toEqual(open);
  });
  it("leaves five points below the header for a bottom-anchored composer", () => {
    const height = resolveComposerCapacity({
      height: 582,
      bottomInset: 24,
      keyboardShift: 308,
      centered: false,
      safeAreaBottom: 0,
    });
    expect(height).toBe(245);
    expect(582 - 24 - 308 - height).toBe(5);
  });

  it("fits a centered tablet form between the header and the keyboard it rises above", () => {
    const height = resolveComposerCapacity({
      height: 1000,
      bottomInset: 80,
      keyboardShift: 300,
      centered: true,
      safeAreaBottom: 20,
    });
    expect(height).toBe(663);
    expect(1000 - 300 - 20 - CENTERED_KEYBOARD_GAP - height).toBe(5);
  });

  it("keeps a usable centered form when an iPad keyboard covers most of the viewport", () => {
    const viewport = { height: 950, bottomInset: 72, centered: true, safeAreaBottom: 20 };
    const open = updateComposerCapacity(undefined, { ...viewport, keyboardShift: 570 });
    const closed = updateComposerCapacity(open, { ...viewport, keyboardShift: 0 });
    expect(open.capacity).toBe(343);
    expect(closed.capacity).toBe(343);
  });

  it("bounds a centered form by its centering inset while no keyboard has opened", () => {
    expect(
      resolveComposerCapacity({
        height: 950,
        bottomInset: 72,
        keyboardShift: 0,
        centered: true,
        safeAreaBottom: 20,
      }),
    ).toBe(873);
  });

  it("uses the measured viewport before the first keyboard opening", () => {
    expect(
      resolveComposerCapacity({
        height: 582,
        bottomInset: 24,
        keyboardShift: 0,
        centered: false,
        safeAreaBottom: 0,
      }),
    ).toBe(553);
    expect(
      resolveComposerCapacity({
        height: 300,
        bottomInset: 0,
        keyboardShift: 200,
        centered: false,
        safeAreaBottom: 0,
      }),
    ).toBe(95);
  });
});
