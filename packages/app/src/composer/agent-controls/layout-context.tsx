import { createContext, useContext, type ReactNode } from "react";
import type { Insets } from "react-native";
import {
  resolveContextWindowMeterRing,
  type ContextWindowMeterRing,
} from "@/components/context-window-meter.utils";
import type { ComposerControlPresentation } from "@/composer/agent-controls/layout";

export interface ComposerControlLayoutValue {
  glyphSize: number;
  /** The context ring beside the intelligence trigger; the gauge is drawn to its size and stroke. */
  ring: ContextWindowMeterRing;
  presentation: ComposerControlPresentation;
  /** Set under touch density; every toolbar trigger passes it to its pressable. */
  hitSlop: Insets | undefined;
}

const DEFAULT_LAYOUT: ComposerControlLayoutValue = {
  glyphSize: 16,
  ring: resolveContextWindowMeterRing(16),
  presentation: {
    showCarets: true,
    showEffortSuffix: true,
    showModeLabel: true,
    showModelLabel: true,
    aggregateFeatures: false,
    showQuickPromptTrigger: true,
  },
  hitSlop: undefined,
};

const ComposerControlLayoutContext = createContext(DEFAULT_LAYOUT);

export function ComposerControlLayoutProvider({
  value,
  children,
}: {
  value: ComposerControlLayoutValue;
  children: ReactNode;
}) {
  return (
    <ComposerControlLayoutContext.Provider value={value}>
      {children}
    </ComposerControlLayoutContext.Provider>
  );
}

export function useComposerControlLayout(): ComposerControlLayoutValue {
  return useContext(ComposerControlLayoutContext);
}
