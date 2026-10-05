import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type {
  ComposerControlDensity,
  ComposerControlPresence,
} from "@/composer/agent-controls/layout";

const EMPTY_CONTROLS: ComposerControlPresence = {
  hasModel: false,
  hasEffort: false,
  hasMode: false,
  features: [],
  fontScale: 1,
  modelLabel: "",
  effortLabel: "",
  modeLabel: "",
};
interface Capacity {
  controls: ComposerControlPresence;
  width: number;
  blocked: boolean;
  density: ComposerControlDensity | null;
}
const EMPTY_CAPACITY: Capacity = {
  controls: EMPTY_CONTROLS,
  width: 0,
  blocked: true,
  density: null,
};
const CapacityContext = createContext<StoreApi<Capacity> | null>(null);
// Agent controls and MessageInput are also used outside a full composer.
const emptyStore = createStore<Capacity>(() => EMPTY_CAPACITY);

export function QuickPromptCapacityProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createStore<Capacity>(() => EMPTY_CAPACITY));
  return <CapacityContext.Provider value={store}>{children}</CapacityContext.Provider>;
}

export function usePublishQuickPromptControls(controls: ComposerControlPresence) {
  const store = useContext(CapacityContext);
  useLayoutEffect(() => {
    store?.setState({ controls });
  }, [controls, store]);
  useLayoutEffect(
    () => () => {
      store?.setState({ controls: EMPTY_CONTROLS });
    },
    [store],
  );
}

/** Measure the actual button-row interior, independent of composer padding and panel width. */
export function usePublishQuickPromptSurface(input: {
  overlay: boolean;
  disabled: boolean;
  readOnly: boolean;
}) {
  const blocked = input.overlay || input.disabled || input.readOnly;
  const store = useContext(CapacityContext);
  useLayoutEffect(() => {
    store?.setState({ blocked });
  }, [blocked, store]);
  useLayoutEffect(
    () => () => {
      store?.setState({ width: 0, blocked: true });
    },
    [store],
  );
  return useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      if (width > 0 && height > 0) store?.setState({ width });
    },
    [store],
  );
}

export function useQuickPromptCapacity() {
  const store = useContext(CapacityContext);
  if (!store) throw new Error("Quick prompt capacity requires its composer provider");
  return useStore(store);
}

export function usePublishQuickPromptDensity(density: ComposerControlDensity | null) {
  const store = useContext(CapacityContext);
  useLayoutEffect(() => {
    store?.setState({ density });
  }, [density, store]);
  useLayoutEffect(
    () => () => {
      store?.setState({ density: null });
    },
    [store],
  );
}

export function useQuickPromptControlDensity() {
  return useStore(useContext(CapacityContext) ?? emptyStore, (state) => state.density);
}
