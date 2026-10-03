import { describe, expect, it } from "vitest";
import {
  type MacOptionAsMeta,
  type MacTerminalKeyEvent,
  OPTION_KEY_LEFT,
  OPTION_KEY_RIGHT,
  nextOptionKeyLocations,
  resolveMacTerminalKeyAction,
} from "./terminal-mac-keys";

function keyEvent(
  key: string,
  modifiers: Partial<Omit<MacTerminalKeyEvent, "key">> = {},
): MacTerminalKeyEvent {
  return {
    type: "keydown",
    key,
    code: modifiers.code ?? "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

function resolve(
  event: MacTerminalKeyEvent,
  context: { optionAsMeta?: MacOptionAsMeta; optionKeyLocations?: number; kitty?: number } = {},
) {
  return resolveMacTerminalKeyAction(event, {
    optionAsMeta: context.optionAsMeta ?? "both",
    optionKeyLocations: context.optionKeyLocations ?? 0,
    kittyKeyboardFlags: context.kitty ?? 0,
  });
}

describe("resolveMacTerminalKeyAction", () => {
  it("maps Cmd editing chords to readline bytes", () => {
    expect(resolve(keyEvent("Backspace", { metaKey: true }))).toEqual({
      type: "input",
      data: "\x15",
    });
    expect(resolve(keyEvent("Delete", { metaKey: true }))).toEqual({ type: "input", data: "\x0b" });
    expect(resolve(keyEvent("ArrowLeft", { metaKey: true }))).toEqual({
      type: "input",
      data: "\x01",
    });
    expect(resolve(keyEvent("ArrowRight", { metaKey: true }))).toEqual({
      type: "input",
      data: "\x05",
    });
  });

  it("scrolls the buffer with Cmd+Up and Cmd+Down", () => {
    expect(resolve(keyEvent("ArrowUp", { metaKey: true }))).toEqual({
      type: "scroll",
      position: "top",
    });
    expect(resolve(keyEvent("ArrowDown", { metaKey: true }))).toEqual({
      type: "scroll",
      position: "bottom",
    });
  });

  it("maps Option word movement and deletion for readline", () => {
    expect(resolve(keyEvent("ArrowLeft", { altKey: true, code: "ArrowLeft" }))).toEqual({
      type: "input",
      data: "\x1bb",
    });
    expect(resolve(keyEvent("ArrowRight", { altKey: true, code: "ArrowRight" }))).toEqual({
      type: "input",
      data: "\x1bf",
    });
    expect(resolve(keyEvent("Backspace", { altKey: true }))).toEqual({
      type: "input",
      data: "\x1b\x7f",
    });
  });

  it("leaves app shortcuts and plain keys to the rest of the pipeline", () => {
    expect(resolve(keyEvent("f", { metaKey: true, code: "KeyF" }))).toBeNull();
    expect(resolve(keyEvent("ArrowRight", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(resolve(keyEvent("a", { code: "KeyA" }))).toBeNull();
    expect(resolve(keyEvent("ArrowLeft", { altKey: true, code: "Numpad4" }))).toBeNull();
  });

  it("defers to xterm when a TUI negotiated the kitty keyboard protocol", () => {
    expect(resolve(keyEvent("Backspace", { metaKey: true }), { kitty: 1 })).toBeNull();
    expect(
      resolve(keyEvent("ArrowLeft", { altKey: true, code: "ArrowLeft" }), { kitty: 1 }),
    ).toBeNull();
  });

  it("encodes Meta only for the configured Option side", () => {
    const optionB = keyEvent("∫", { altKey: true, code: "KeyB" });
    expect(resolve(optionB, { optionAsMeta: "left", optionKeyLocations: OPTION_KEY_LEFT })).toEqual(
      { type: "input", data: "\x1bb" },
    );
    expect(
      resolve(optionB, { optionAsMeta: "left", optionKeyLocations: OPTION_KEY_RIGHT }),
    ).toBeNull();
    expect(
      resolve(keyEvent("Dead", { altKey: true, code: "KeyE" }), {
        optionAsMeta: "right",
        optionKeyLocations: OPTION_KEY_RIGHT,
      }),
    ).toEqual({ type: "input", data: "\x1be" });
    expect(
      resolve(keyEvent("@", { altKey: true, shiftKey: true, code: "Digit2" }), {
        optionAsMeta: "left",
        optionKeyLocations: OPTION_KEY_LEFT,
      }),
    ).toEqual({ type: "input", data: "\x1b@" });
  });

  it("leaves both-sides Meta and composing to xterm", () => {
    const optionB = keyEvent("∫", { altKey: true, code: "KeyB" });
    expect(
      resolve(optionB, { optionAsMeta: "both", optionKeyLocations: OPTION_KEY_LEFT }),
    ).toBeNull();
    expect(
      resolve(optionB, { optionAsMeta: "off", optionKeyLocations: OPTION_KEY_LEFT }),
    ).toBeNull();
  });
});

describe("nextOptionKeyLocations", () => {
  it("tracks each Option key and clears once Option is released", () => {
    let locations = nextOptionKeyLocations(0, keyEvent("Alt", { code: "AltLeft", altKey: true }));
    expect(locations).toBe(OPTION_KEY_LEFT);
    locations = nextOptionKeyLocations(
      locations,
      keyEvent("Alt", { code: "AltRight", altKey: true }),
    );
    expect(locations).toBe(OPTION_KEY_LEFT | OPTION_KEY_RIGHT);
    locations = nextOptionKeyLocations(locations, {
      ...keyEvent("Alt", { code: "AltLeft", altKey: true }),
      type: "keyup",
    });
    expect(locations).toBe(OPTION_KEY_RIGHT);
    expect(nextOptionKeyLocations(locations, keyEvent("a", { code: "KeyA" }))).toBe(0);
  });
});
