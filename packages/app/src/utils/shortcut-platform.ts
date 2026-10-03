import { Platform } from "react-native";
import { getIsElectronRuntime, getIsElectronRuntimeMac } from "@/constants/layout";
import type { ShortcutOs } from "@/utils/format-shortcut";
import { isNative } from "@/constants/platform";
import { isMacUserAgent } from "@/utils/mac-user-agent";
import { hardwareKeyCommandsSupported } from "@/native/ios-hardware-key-commands";

export function getShortcutOs(): ShortcutOs {
  if (isNative) {
    return Platform.OS === "ios" ? "mac" : "non-mac";
  }
  if (getIsElectronRuntimeMac()) return "mac";
  return isMacUserAgent() ? "mac" : "non-mac";
}

export interface ShortcutPlatform {
  isMac: boolean;
  isDesktop: boolean;
}

/**
 * `isDesktop` selects the bindings for an app that owns its whole window, as
 * opposed to a browser tab that has to leave Cmd+W or Cmd+1 to the browser.
 * The iPad app owns its window the same way Electron does.
 */
export function getShortcutPlatform(): ShortcutPlatform {
  return {
    isMac: getShortcutOs() === "mac",
    isDesktop: getIsElectronRuntime() || hardwareKeyCommandsSupported,
  };
}
