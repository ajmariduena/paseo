import { useEffect, useRef } from "react";
import type { KeyboardFocusScope } from "@/keyboard/actions";
import { nativeKeyCommandRegistry } from "@/keyboard/native-key-command-registry";
import type { NativeKeyCommand, NativeKeyCommandEvent } from "@/keyboard/native-key-commands";
import { hardwareKeyCommandsSupported } from "@/native/ios-hardware-key-commands";

interface UseNativeKeyCommandLayerInput {
  enabled: boolean;
  commands: readonly NativeKeyCommand[];
  priority: number;
  focusScope?: KeyboardFocusScope;
  handle: (event: NativeKeyCommandEvent) => boolean;
}

/**
 * Registers hardware keyboard commands on the iPad while `enabled`. A no-op on
 * every other platform. `handle` is read live, so only a change to the command
 * set re-registers the layer.
 */
export function useNativeKeyCommandLayer(input: UseNativeKeyCommandLayerInput) {
  const handleRef = useRef(input.handle);
  handleRef.current = input.handle;
  const isEnabled = hardwareKeyCommandsSupported && input.enabled;

  useEffect(() => {
    if (!isEnabled) return;
    return nativeKeyCommandRegistry.addLayer({
      commands: input.commands,
      priority: input.priority,
      focusScope: input.focusScope,
      handle: (event) => handleRef.current(event),
    });
  }, [input.commands, input.focusScope, input.priority, isEnabled]);
}
