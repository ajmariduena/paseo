import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHardwareKeyboardConnected } from "@/hooks/use-hardware-keyboard-connected";

interface KeyboardShortcutEnvironment {
  isNative: boolean;
  isCompact: boolean;
  hasHardwareKeyboard: boolean;
}

export function keyboardShortcutsAvailable({
  isNative: native,
  isCompact,
  hasHardwareKeyboard,
}: KeyboardShortcutEnvironment): boolean {
  if (isCompact) return false;
  return !native || hasHardwareKeyboard;
}

export function useKeyboardShortcutsAvailable(): boolean {
  const isCompact = useIsCompactFormFactor();
  const hasHardwareKeyboard = useHardwareKeyboardConnected();
  return keyboardShortcutsAvailable({ isNative, isCompact, hasHardwareKeyboard });
}
