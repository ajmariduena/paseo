import { useSyncExternalStore } from "react";
import {
  addHardwareKeyboardConnectionListener,
  hardwareKeyCommandsSupported,
  isHardwareKeyboardConnected,
} from "@/native/ios-hardware-key-commands";

let connected: boolean | null = null;

function subscribe(onChange: () => void) {
  const subscription = addHardwareKeyboardConnectionListener((event) => {
    connected = event.connected;
    onChange();
  });
  return () => subscription.remove();
}

function getSnapshot(): boolean {
  connected ??= hardwareKeyCommandsSupported && isHardwareKeyboardConnected();
  return connected;
}

/** Whether an iPad has a hardware keyboard attached. Always false elsewhere. */
export function useHardwareKeyboardConnected(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
