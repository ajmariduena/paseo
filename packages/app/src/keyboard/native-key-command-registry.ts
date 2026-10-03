import type { KeyboardFocusScope } from "@/keyboard/actions";
import type { NativeKeyCommand, NativeKeyCommandEvent } from "@/keyboard/native-key-commands";
import {
  addHardwareKeyCommandListener,
  setHardwareKeyCommands,
} from "@/native/ios-hardware-key-commands";

/**
 * A set of key commands owned by one surface. Higher `priority` layers are asked
 * first, then the most recently added; `handle` returns false to let the next
 * layer claiming the same command try. A layer with a `focusScope` declares that
 * scope active for as long as it is registered.
 */
export interface NativeKeyCommandLayer {
  commands: readonly NativeKeyCommand[];
  priority: number;
  focusScope?: KeyboardFocusScope;
  handle: (event: NativeKeyCommandEvent) => boolean;
}

export interface NativeKeyCommandPort {
  setCommands(commands: readonly NativeKeyCommand[]): void;
  addListener(handler: (event: NativeKeyCommandEvent) => void): { remove: () => void };
}

interface RegisteredLayer {
  layer: NativeKeyCommandLayer;
  order: number;
}

function mergeCommands(layers: readonly RegisteredLayer[]): NativeKeyCommand[] {
  const commandsById = new Map<string, NativeKeyCommand>();
  for (const { layer } of layers) {
    for (const command of layer.commands) {
      const existing = commandsById.get(command.id);
      if (!existing) {
        commandsById.set(command.id, { ...command });
        continue;
      }
      existing.inTextInput ||= command.inTextInput;
      existing.outsideTextInput ||= command.outsideTextInput;
      existing.title ??= command.title;
    }
  }
  return Array.from(commandsById.values());
}

function byPrecedence(left: RegisteredLayer, right: RegisteredLayer): number {
  if (left.layer.priority !== right.layer.priority) {
    return right.layer.priority - left.layer.priority;
  }
  return right.order - left.order;
}

export function createNativeKeyCommandRegistry(port: NativeKeyCommandPort) {
  let nextOrder = 1;
  let layers: RegisteredLayer[] = [];
  let subscription: { remove: () => void } | null = null;

  function dispatch(event: NativeKeyCommandEvent): boolean {
    for (const { layer } of layers) {
      if (!layer.commands.some((command) => command.id === event.id)) continue;
      if (layer.handle(event)) return true;
    }
    return false;
  }

  function publish() {
    port.setCommands(mergeCommands(layers));
  }

  return {
    addLayer(layer: NativeKeyCommandLayer): () => void {
      subscription ??= port.addListener(dispatch);
      const entry: RegisteredLayer = { layer, order: nextOrder++ };
      layers = [...layers, entry].sort(byPrecedence);
      publish();
      return () => {
        if (!layers.includes(entry)) return;
        layers = layers.filter((candidate) => candidate !== entry);
        publish();
      };
    },

    activeFocusScope(): KeyboardFocusScope | null {
      return layers.find(({ layer }) => layer.focusScope)?.layer.focusScope ?? null;
    },

    dispatch,
  };
}

export const nativeKeyCommandRegistry = createNativeKeyCommandRegistry({
  setCommands: setHardwareKeyCommands,
  addListener: addHardwareKeyCommandListener,
});
