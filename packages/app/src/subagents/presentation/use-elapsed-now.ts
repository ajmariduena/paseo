import { useCallback, useSyncExternalStore } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { sharedSecondClock } from "./elapsed-clock";

function subscribeToNothing(): () => void {
  return () => undefined;
}

/**
 * The shared clock's current second while `active` and the surrounding retained panel is visible.
 * A hidden panel keeps its last rendered value and receives no ticks.
 */
export function useElapsedNow(active: boolean): number {
  const panelActive = useRetainedPanelActive();
  const ticking = active && panelActive;
  const subscribe = useCallback(
    (listener: () => void) =>
      ticking ? sharedSecondClock.subscribe(listener) : subscribeToNothing(),
    [ticking],
  );
  return useSyncExternalStore(
    subscribe,
    sharedSecondClock.getSnapshot,
    sharedSecondClock.getSnapshot,
  );
}
