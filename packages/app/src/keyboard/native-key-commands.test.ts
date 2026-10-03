import { describe, expect, it } from "vitest";
import {
  buildEffectiveBindings,
  resolveKeyboardShortcut,
  type ChordState,
} from "@/keyboard/keyboard-shortcuts";
import {
  buildNativeKeyCommands,
  nativeKeyCommandForCombo,
  resolveNativeKeyboardFocusScope,
  shortcutInputForNativeKeyCommand,
  type NativeKeyCommand,
} from "./native-key-commands";

const IPAD = { isMac: true, isDesktop: true };

function titleForHelp(input: { label: string; digit: number | null }): string {
  return input.digit === null ? input.label : `${input.label} ${input.digit}`;
}

function ipadCommands(overrides: Record<string, string | null> = {}): NativeKeyCommand[] {
  return buildNativeKeyCommands({
    bindings: buildEffectiveBindings(overrides),
    platform: IPAD,
    titleForHelp,
  });
}

function commandById(commands: readonly NativeKeyCommand[], id: string): NativeKeyCommand {
  const command = commands.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`missing native command ${id}`);
  return command;
}

function idleChordState(): ChordState {
  return { candidateIndices: [], step: 0, timeoutId: null };
}

describe("buildNativeKeyCommands", () => {
  it("registers the desktop Mac shortcuts the iPad needs", () => {
    const ids = ipadCommands().map((command) => command.id);

    expect(ids).toEqual(
      expect.arrayContaining(["Cmd+K", "Cmd+N", "Cmd+B", "Cmd+E", "Cmd+W", "Cmd+L", "Escape"]),
    );
    expect(ids).toEqual(
      expect.arrayContaining([1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => `Cmd+${digit}`)),
    );
  });

  it("describes each command as UIKit input, modifiers and an overlay title", () => {
    const commands = ipadCommands();

    expect(commandById(commands, "Cmd+K")).toEqual({
      id: "Cmd+K",
      input: "k",
      modifiers: ["command"],
      title: "Toggle command center",
      inTextInput: true,
      outsideTextInput: true,
    });
    expect(commandById(commands, "Cmd+3")).toMatchObject({
      input: "3",
      modifiers: ["command"],
      title: "Jump to workspace 3",
    });
  });

  it("never takes keys that type text", () => {
    const ids = ipadCommands().map((command) => command.id);

    expect(ids).not.toContain("Space");
    expect(ids).not.toContain("Enter");
    expect(ids).not.toContain("Shift+?");
  });

  it("leaves a combo to the text system when no binding can use it while typing", () => {
    const paneFocus = commandById(ipadCommands(), "Shift+Cmd+ArrowLeft");

    expect(paneFocus).toMatchObject({ inTextInput: false, outsideTextInput: true });
  });

  it("skips browser-tab variants and chords", () => {
    const ids = ipadCommands({ "command-center-toggle-cmd-k-mac": "Cmd+J Cmd+K" }).map(
      (command) => command.id,
    );

    expect(ids).not.toContain("Alt+1");
    expect(ids).not.toContain("Cmd+J");
    expect(ids).not.toContain("Cmd+K");
  });

  it("follows a user override to the new keys", () => {
    const commands = ipadCommands({ "command-center-toggle-cmd-k-mac": "Cmd+Shift+K" });

    expect(commandById(commands, "Shift+Cmd+K")).toMatchObject({
      input: "k",
      modifiers: ["command", "shift"],
    });
  });
});

describe("shortcutInputForNativeKeyCommand", () => {
  it("replays a fired command through the same matcher the web uses", () => {
    const bindings = buildEffectiveBindings({});
    const resolve = (id: string) =>
      resolveKeyboardShortcut({
        event: shortcutInputForNativeKeyCommand(id),
        context: { ...IPAD, focusScope: "other", commandCenterOpen: false },
        chordState: idleChordState(),
        onChordReset: () => {},
        bindings,
      }).match;

    expect(resolve("Cmd+K")).toMatchObject({ action: "command-center.toggle", payload: null });
    expect(resolve("Cmd+4")).toMatchObject({
      action: "workspace.navigate.index",
      payload: { index: 4 },
    });
    expect(resolve("Escape")).toMatchObject({ action: "agent.interrupt" });
  });
});

describe("nativeKeyCommandForCombo", () => {
  it("spells Return and arrows with the names the native module maps", () => {
    expect(
      nativeKeyCommandForCombo("Cmd+Enter", { inTextInput: true, outsideTextInput: false }),
    ).toEqual({
      id: "Cmd+Enter",
      input: "Enter",
      modifiers: ["command"],
      title: null,
      inTextInput: true,
      outsideTextInput: false,
    });
    expect(
      nativeKeyCommandForCombo("ArrowDown", { inTextInput: true, outsideTextInput: true }),
    ).toMatchObject({ id: "ArrowDown", input: "ArrowDown", modifiers: [] });
  });
});

describe("resolveNativeKeyboardFocusScope", () => {
  it("maps the native first responder onto the web focus scopes", () => {
    const scope = (input: Partial<Parameters<typeof resolveNativeKeyboardFocusScope>[0]>) =>
      resolveNativeKeyboardFocusScope({
        textInputFocused: false,
        messageInputFocused: false,
        commandCenterOpen: false,
        ...input,
      });

    expect(scope({})).toBe("other");
    expect(scope({ textInputFocused: true })).toBe("editable");
    expect(scope({ textInputFocused: true, messageInputFocused: true })).toBe("message-input");
    expect(scope({ textInputFocused: true, commandCenterOpen: true })).toBe("command-center");
  });
});
