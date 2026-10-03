import type { EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardConnectionEvent,
  NativeKeyCommand,
  NativeKeyCommandEvent,
} from "@/keyboard/native-key-commands";

export const hardwareKeyCommandsSupported = false;

export function setHardwareKeyCommands(_commands: readonly NativeKeyCommand[]) {}

export function addHardwareKeyCommandListener(
  _handler: (event: NativeKeyCommandEvent) => void,
): EventSubscription {
  return { remove: () => {} };
}

export function isHardwareKeyboardConnected(): boolean {
  return false;
}

export function addHardwareKeyboardConnectionListener(
  _handler: (event: HardwareKeyboardConnectionEvent) => void,
): EventSubscription {
  return { remove: () => {} };
}
