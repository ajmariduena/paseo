import { describe, expect, it } from "vitest";
import { createNativeKeyCommandRegistry } from "./native-key-command-registry";
import { nativeKeyCommandForCombo, type NativeKeyCommand } from "./native-key-commands";

function command(combo: string, scopes = { inTextInput: true, outsideTextInput: true }) {
  return nativeKeyCommandForCombo(combo, scopes);
}

function createHarness() {
  const published: NativeKeyCommand[][] = [];
  let listener: ((event: { id: string; textInputFocused: boolean }) => void) | null = null;
  const registry = createNativeKeyCommandRegistry({
    setCommands: (commands) => published.push([...commands]),
    addListener: (handler) => {
      listener = handler;
      return { remove: () => {} };
    },
  });
  function fire(id: string) {
    listener?.({ id, textInputFocused: true });
  }
  return { registry, published, fire };
}

describe("createNativeKeyCommandRegistry", () => {
  it("publishes the union of every layer, merging a combo two layers share", () => {
    const { registry, published } = createHarness();

    registry.addLayer({
      commands: [
        command("Cmd+K"),
        command("Escape", { inTextInput: false, outsideTextInput: true }),
      ],
      priority: 0,
      handle: () => true,
    });
    const remove = registry.addLayer({
      commands: [command("Escape", { inTextInput: true, outsideTextInput: false })],
      priority: 2,
      handle: () => true,
    });

    expect(published.at(-1)).toEqual([
      command("Escape", { inTextInput: true, outsideTextInput: true }),
      command("Cmd+K"),
    ]);

    remove();
    expect(published.at(-1)).toEqual([
      command("Cmd+K"),
      command("Escape", { inTextInput: false, outsideTextInput: true }),
    ]);
  });

  it("asks the higher-priority layer first and falls through when it declines", () => {
    const { registry, fire } = createHarness();
    const calls: string[] = [];
    let autocompleteHandles = true;

    registry.addLayer({
      commands: [command("Escape")],
      priority: 0,
      handle: () => {
        calls.push("global");
        return true;
      },
    });
    registry.addLayer({
      commands: [command("Escape")],
      priority: 2,
      handle: () => {
        calls.push("autocomplete");
        return autocompleteHandles;
      },
    });

    fire("Escape");
    autocompleteHandles = false;
    fire("Escape");

    expect(calls).toEqual(["autocomplete", "autocomplete", "global"]);
  });

  it("keeps a re-registered global layer below the contextual ones", () => {
    const { registry, fire } = createHarness();
    const calls: string[] = [];

    registry.addLayer({
      commands: [command("Escape")],
      priority: 2,
      handle: () => {
        calls.push("command-center");
        return true;
      },
    });
    registry.addLayer({
      commands: [command("Escape")],
      priority: 0,
      handle: () => {
        calls.push("global");
        return true;
      },
    });

    fire("Escape");

    expect(calls).toEqual(["command-center"]);
  });

  it("reports the focus scope a registered layer declares", () => {
    const { registry } = createHarness();

    expect(registry.activeFocusScope()).toBeNull();
    const remove = registry.addLayer({
      commands: [command("Cmd+Enter")],
      priority: 1,
      focusScope: "message-input",
      handle: () => true,
    });
    expect(registry.activeFocusScope()).toBe("message-input");
    remove();
    expect(registry.activeFocusScope()).toBeNull();
  });
});
