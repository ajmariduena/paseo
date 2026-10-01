import type { ServiceUrlBehavior } from "@/hooks/use-settings";

export interface WebLinkModifiers {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export type WebLinkDestination = "in-app" | "external";

export function readWebLinkModifiers(event: unknown): WebLinkModifiers | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const source = "nativeEvent" in event && event.nativeEvent ? event.nativeEvent : event;
  if (typeof source !== "object") {
    return undefined;
  }
  const { shiftKey, metaKey, ctrlKey } = source as Record<string, unknown>;
  return {
    shiftKey: shiftKey === true,
    metaKey: metaKey === true,
    ctrlKey: ctrlKey === true,
  };
}

export function isAlternateWebLinkChord(
  modifiers: WebLinkModifiers | undefined,
  isMac: boolean,
): boolean {
  if (!modifiers?.shiftKey) {
    return false;
  }
  return Boolean(isMac ? modifiers.metaKey : modifiers.ctrlKey);
}

export function resolveWebLinkDestination(input: {
  behavior: ServiceUrlBehavior;
  invertModifier: boolean;
  alternateChord: boolean;
}): WebLinkDestination | "ask" {
  if (!input.invertModifier || !input.alternateChord) {
    return input.behavior;
  }
  // With "ask" there is no saved default to invert, so the chord skips the prompt and opens in Paseo.
  return input.behavior === "in-app" ? "external" : "in-app";
}
