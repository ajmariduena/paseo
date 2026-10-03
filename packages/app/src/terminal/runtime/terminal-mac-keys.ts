export const MAC_OPTION_AS_META_VALUES = ["both", "left", "right", "off"] as const;
/** Which Option keys act as Meta; the other side keeps composing accents and symbols. */
export type MacOptionAsMeta = (typeof MAC_OPTION_AS_META_VALUES)[number];
export const DEFAULT_MAC_OPTION_AS_META: MacOptionAsMeta = "both";

export const OPTION_KEY_LEFT = 1;
export const OPTION_KEY_RIGHT = 2;

export interface MacTerminalKeyEvent {
  type: string;
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type MacTerminalKeyAction =
  | { type: "input"; data: string }
  | { type: "scroll"; position: "top" | "bottom" };

const SHIFTED_PC101: Record<string, [string, string]> = {
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Backquote: ["`", "~"],
  Space: [" ", " "],
  Digit0: ["0", ")"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
};

/** The character a key produces without Option, from its physical position on a US layout. */
function baseCharacterForCode(code: string, shift: boolean): string | null {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return shift ? letter : letter.toLowerCase();
  const pair = SHIFTED_PC101[code];
  return pair ? pair[shift ? 1 : 0] : null;
}

const OPTION_KEY_BITS: Record<string, number> = {
  AltLeft: OPTION_KEY_LEFT,
  AltRight: OPTION_KEY_RIGHT,
};

const CMD_KEY_ACTIONS: Record<string, MacTerminalKeyAction> = {
  Backspace: { type: "input", data: "\x15" },
  Delete: { type: "input", data: "\x0b" },
  ArrowLeft: { type: "input", data: "\x01" },
  ArrowRight: { type: "input", data: "\x05" },
  ArrowUp: { type: "scroll", position: "top" },
  ArrowDown: { type: "scroll", position: "bottom" },
};

const OPTION_KEY_ACTIONS: Record<string, MacTerminalKeyAction> = {
  Backspace: { type: "input", data: "\x1b\x7f" },
  ArrowLeft: { type: "input", data: "\x1bb" },
  ArrowRight: { type: "input", data: "\x1bf" },
};

/** Tracks which Option keys are held, since a letter keydown does not say which side is down. */
export function nextOptionKeyLocations(locations: number, event: MacTerminalKeyEvent): number {
  const bit = OPTION_KEY_BITS[event.code] ?? 0;
  if (!event.altKey && bit === 0) return 0;
  if (bit === 0) return locations;
  return event.type === "keyup" ? locations & ~bit : locations | bit;
}

function optionActsAsMeta(setting: MacOptionAsMeta, locations: number): boolean {
  if (setting === "left") return (locations & OPTION_KEY_LEFT) !== 0;
  if (setting === "right") return (locations & OPTION_KEY_RIGHT) !== 0;
  return false;
}

function resolveOptionKeyAction(
  event: MacTerminalKeyEvent,
  context: { optionAsMeta: MacOptionAsMeta; optionKeyLocations: number },
): MacTerminalKeyAction | null {
  const editing =
    event.shiftKey || event.code.startsWith("Numpad") ? undefined : OPTION_KEY_ACTIONS[event.key];
  if (editing) return editing;
  // "both" is xterm's own macOptionIsMeta; a single side has to be encoded here.
  if (!optionActsAsMeta(context.optionAsMeta, context.optionKeyLocations)) return null;
  const character = baseCharacterForCode(event.code, event.shiftKey);
  return character ? { type: "input", data: `\x1b${character}` } : null;
}

/**
 * Translates macOS editing chords into the readline bytes iTerm2 and Ghostty send, since xterm.js
 * maps none of them. A TUI that negotiated the kitty keyboard protocol gets xterm's native encoding.
 */
export function resolveMacTerminalKeyAction(
  event: MacTerminalKeyEvent,
  context: {
    optionAsMeta: MacOptionAsMeta;
    optionKeyLocations: number;
    kittyKeyboardFlags: number;
  },
): MacTerminalKeyAction | null {
  if (event.type !== "keydown" || context.kittyKeyboardFlags > 0 || event.ctrlKey) return null;
  if (event.metaKey) {
    return event.altKey || event.shiftKey ? null : (CMD_KEY_ACTIONS[event.key] ?? null);
  }
  return event.altKey ? resolveOptionKeyAction(event, context) : null;
}
