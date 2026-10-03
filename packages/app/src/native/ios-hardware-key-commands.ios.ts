import { Platform } from "react-native";
import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardConnectionEvent,
  NativeKeyCommand,
  NativeKeyCommandEvent,
} from "@/keyboard/native-key-commands";

interface PaseoHardwareKeyboardModule {
  setKeyCommands(commands: readonly NativeKeyCommand[]): void;
  isHardwareKeyboardConnected(): boolean;
  addListener(
    eventName: "onHardwareKeyCommand",
    handler: (event: NativeKeyCommandEvent) => void,
  ): EventSubscription;
  addListener(
    eventName: "onHardwareKeyboardConnectionChange",
    handler: (event: HardwareKeyboardConnectionEvent) => void,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export const hardwareKeyCommandsSupported = Platform.OS === "ios" && Platform.isPad;

export function setHardwareKeyCommands(commands: readonly NativeKeyCommand[]) {
  module.setKeyCommands(commands);
}

export function addHardwareKeyCommandListener(handler: (event: NativeKeyCommandEvent) => void) {
  return module.addListener("onHardwareKeyCommand", handler);
}

export function isHardwareKeyboardConnected(): boolean {
  return module.isHardwareKeyboardConnected();
}

export function addHardwareKeyboardConnectionListener(
  handler: (event: HardwareKeyboardConnectionEvent) => void,
) {
  return module.addListener("onHardwareKeyboardConnectionChange", handler);
}
