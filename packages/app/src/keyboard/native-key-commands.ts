import type { KeyboardFocusScope } from "@/keyboard/actions";
import {
  matchesKeyboardShortcutContext,
  type KeyboardShortcutInput,
  type ParsedShortcutBinding,
} from "@/keyboard/keyboard-shortcuts";
import { keyComboToString, parseShortcutString, type KeyCombo } from "@/keyboard/shortcut-string";

export type NativeKeyModifier = "command" | "control" | "alternate" | "shift";

/**
 * One `UIKeyCommand` the iPad registers. `id` is the canonical combo string
 * ("Cmd+Alt+A"); it is what the native side reports back when the keys fire.
 * `inTextInput` / `outsideTextInput` say whether the command may claim the keys
 * while a text field is (or is not) first responder: a combo no binding can use
 * while typing must not steal it from the text system.
 */
export interface NativeKeyCommand {
  id: string;
  input: string;
  modifiers: NativeKeyModifier[];
  title: string | null;
  inTextInput: boolean;
  outsideTextInput: boolean;
}

export interface NativeKeyCommandEvent {
  id: string;
  textInputFocused: boolean;
}

export interface HardwareKeyboardConnectionEvent {
  connected: boolean;
}

export interface NativeKeyCommandScopes {
  inTextInput: boolean;
  outsideTextInput: boolean;
}

interface ShortcutHelpTitleInput {
  helpId: string;
  label: string;
  digit: number | null;
}

interface BuildNativeKeyCommandsInput {
  bindings: readonly ParsedShortcutBinding[];
  platform: { isMac: boolean; isDesktop: boolean };
  titleForHelp: (input: ShortcutHelpTitleInput) => string;
}

// A bare key or Shift+key types text, so only these are worth taking from the text system.
const UNMODIFIED_COMMAND_CODES = new Set(["Escape"]);
const SHIFT_ONLY_COMMAND_CODES = new Set(["Tab"]);
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function hasCommandModifier(combo: KeyCombo): boolean {
  return Boolean(combo.meta || combo.ctrl || combo.alt || combo.mod);
}

function isNativeCommandCombo(combo: KeyCombo): boolean {
  if (hasCommandModifier(combo)) return true;
  if (combo.shift) return SHIFT_ONLY_COMMAND_CODES.has(combo.code);
  return UNMODIFIED_COMMAND_CODES.has(combo.code);
}

function resolveModKey(combo: KeyCombo, isMac: boolean): KeyCombo {
  if (!combo.mod) return combo;
  const { mod: _mod, ...rest } = combo;
  return isMac ? { ...rest, meta: true } : { ...rest, ctrl: true };
}

function expandDigitCombos(combo: KeyCombo): { combo: KeyCombo; digit: number | null }[] {
  if (combo.code !== "Digit") return [{ combo, digit: null }];
  return DIGITS.map((digit) => ({
    combo: { ...combo, code: `Digit${digit}`, key: String(digit) },
    digit,
  }));
}

function nativeInputForCombo(combo: KeyCombo): string {
  if (combo.key !== undefined) return combo.key;
  return keyComboToString({ code: combo.code });
}

function nativeModifiersForCombo(combo: KeyCombo): NativeKeyModifier[] {
  const modifiers: NativeKeyModifier[] = [];
  if (combo.meta) modifiers.push("command");
  if (combo.ctrl) modifiers.push("control");
  if (combo.alt) modifiers.push("alternate");
  if (combo.shift) modifiers.push("shift");
  return modifiers;
}

function bindingScopes(
  binding: ParsedShortcutBinding,
  platform: BuildNativeKeyCommandsInput["platform"],
): NativeKeyCommandScopes {
  function allowedIn(focusScope: KeyboardFocusScope): boolean {
    return matchesKeyboardShortcutContext(binding.when, {
      ...platform,
      focusScope,
      commandCenterOpen: false,
    });
  }
  return {
    inTextInput: allowedIn("message-input") || allowedIn("editable"),
    outsideTextInput: allowedIn("other"),
  };
}

export function nativeKeyCommandForCombo(
  comboString: string,
  scopes: NativeKeyCommandScopes,
): NativeKeyCommand {
  const combo = resolveModKey(parseShortcutString(comboString), true);
  return {
    id: keyComboToString(combo),
    input: nativeInputForCombo(combo),
    modifiers: nativeModifiersForCombo(combo),
    title: null,
    ...scopes,
  };
}

export function nativeNavigationKeyCommands(keys: readonly string[]): NativeKeyCommand[] {
  return keys.map((key) =>
    nativeKeyCommandForCombo(key, { inTextInput: true, outsideTextInput: true }),
  );
}

/**
 * Every single-step shortcut the effective bindings can fire on this platform,
 * as native key commands. Multi-step chords stay web-only: UIKit has no notion
 * of a pending chord.
 */
export function buildNativeKeyCommands(input: BuildNativeKeyCommandsInput): NativeKeyCommand[] {
  const commandsById = new Map<string, NativeKeyCommand>();

  for (const binding of input.bindings) {
    const firstCombo = binding.parsedChord[0];
    if (!firstCombo || binding.parsedChord.length !== 1) continue;
    const scopes = bindingScopes(binding, input.platform);
    if (!scopes.inTextInput && !scopes.outsideTextInput) continue;
    const combo = resolveModKey(firstCombo, input.platform.isMac);
    if (!isNativeCommandCombo(combo)) continue;

    for (const expanded of expandDigitCombos(combo)) {
      const id = keyComboToString(expanded.combo);
      const help = binding.help;
      const title = help
        ? input.titleForHelp({ helpId: help.id, label: help.label, digit: expanded.digit })
        : null;
      const existing = commandsById.get(id);
      if (existing) {
        existing.inTextInput ||= scopes.inTextInput;
        existing.outsideTextInput ||= scopes.outsideTextInput;
        existing.title ??= title;
        continue;
      }
      commandsById.set(id, {
        id,
        input: nativeInputForCombo(expanded.combo),
        modifiers: nativeModifiersForCombo(expanded.combo),
        title,
        ...scopes,
      });
    }
  }

  return Array.from(commandsById.values());
}

/** The keyboard event a fired native command stands for, so it can run through the web matcher. */
export function shortcutInputForNativeKeyCommand(id: string): KeyboardShortcutInput {
  const combo = parseShortcutString(id);
  return {
    key: combo.key ?? keyComboToString({ code: combo.code }),
    code: combo.code,
    metaKey: Boolean(combo.meta || combo.mod),
    ctrlKey: Boolean(combo.ctrl),
    altKey: Boolean(combo.alt),
    shiftKey: Boolean(combo.shift),
    repeat: false,
  };
}

export function resolveNativeKeyboardFocusScope(input: {
  textInputFocused: boolean;
  messageInputFocused: boolean;
  commandCenterOpen: boolean;
}): KeyboardFocusScope {
  if (input.commandCenterOpen) return "command-center";
  if (!input.textInputFocused) return "other";
  return input.messageInputFocused ? "message-input" : "editable";
}
