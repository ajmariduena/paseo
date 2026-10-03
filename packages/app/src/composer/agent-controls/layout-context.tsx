import { createContext, useContext, type ReactNode } from "react";
import type { Insets } from "react-native";
import type { ComposerControlPresentation } from "@/composer/agent-controls/layout";

interface ComposerControlLayoutValue {
  glyphSize: number;
  presentation: ComposerControlPresentation;
  /** Set under touch density; every toolbar trigger passes it to its pressable. */
  hitSlop: Insets | undefined;
}

const DEFAULT_LAYOUT: ComposerControlLayoutValue = {
  glyphSize: 16,
  presentation: {
    showCarets: true,
    showThinkingLabel: true,
    showModeLabel: true,
    aggregateFeatures: false,
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
