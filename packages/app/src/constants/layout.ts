import { useUnistyles } from "react-native-unistyles";
import { resolveControlDensity, type ControlDensity } from "@/components/ui/control-geometry";
import { isNative, isWeb } from "@/constants/platform";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";

export const FOOTER_HEIGHT = 75;

// Shared header inner height (excluding safe area insets and border)
// Used by both agent header (ScreenHeader) and explorer sidebar header
// This ensures both headers have the same visual height
export const HEADER_INNER_HEIGHT = 36;
export const HEADER_INNER_HEIGHT_MOBILE = 56;
// Wide layout under touch density. Compact already uses HEADER_INNER_HEIGHT_MOBILE.
export const HEADER_INNER_HEIGHT_TOUCH = 44;
export const WORKSPACE_SECONDARY_HEADER_HEIGHT = 36;
export const WORKSPACE_SECONDARY_HEADER_HEIGHT_TOUCH = 44;
export const HEADER_TOP_PADDING_MOBILE = 8;

export const COMPACT_FORM_FACTOR_WIDTH = 500;

// Settings uses the canonical desktop list + detail layout. Its sidebar and
// detail target must fit together before it can share width with app navigation.
export const SETTINGS_DESKTOP_SIDEBAR_WIDTH = 320;
export const SETTINGS_DESKTOP_DETAIL_MIN_WIDTH = 400;
export const SETTINGS_DESKTOP_SPLIT_MIN_WIDTH =
  SETTINGS_DESKTOP_SIDEBAR_WIDTH + SETTINGS_DESKTOP_DETAIL_MIN_WIDTH;

// Desktop app constants for macOS traffic light buttons
// These buttons (close/minimize/maximize) overlay the top-left corner
export const DESKTOP_TRAFFIC_LIGHT_WIDTH = 78;
export const DESKTOP_TRAFFIC_LIGHT_HEIGHT = 45;

// Custom desktop window controls (minimize/maximize/close) — top-right
export const DESKTOP_WINDOW_CONTROLS_HEIGHT = HEADER_INNER_HEIGHT;

export {
  getIsElectron as getIsElectronRuntime,
  getIsElectronMac as getIsElectronRuntimeMac,
} from "./platform";

/**
 * Reactive hook — re-renders the component when the breakpoint changes.
 * Always use this instead of reading UnistylesRuntime.breakpoint directly.
 */
export function useIsCompactFormFactor(): boolean {
  const { rt } = useUnistyles();
  return rt.breakpoint === "xs" || rt.breakpoint === "sm";
}

/**
 * "touch" on native, and on web when no fine pointer is present. Never derive it from width: a
 * Mac with a mouse in a narrow window stays "pointer", a wide iPad stays "touch".
 */
export function useControlDensity(): ControlDensity {
  const hasFinePointer = useHasFinePointer();
  return resolveControlDensity({ isNative, hasFinePointer });
}

// SplitContainer relies on dnd-kit and DOM-backed accessibility helpers.
// Keep that capability distinct from desktop-width layout so touch tablets
// can use the desktop shell without entering web-only code paths.
export function supportsDesktopPaneSplits(): boolean {
  return isWeb;
}
