export interface ClockTimer<THandle> {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): THandle;
  clearTimeout(handle: THandle): void;
}

export interface SecondClock {
  /** Registers a listener for each wall-clock second; the clock runs only while one is registered. */
  subscribe(listener: () => void): () => void;
  /** The current wall-clock second, in milliseconds. Stable within a second. */
  getSnapshot(): number;
}

const SECOND_MS = 1000;
// Fires just past the boundary so the floored second has already advanced when listeners read it.
const BOUNDARY_SLACK_MS = 5;

/**
 * One ticker for every elapsed timer on screen. Rows read the floored second instead of keeping
 * their own interval, so a transcript with many live children commits once per second, and a
 * hidden panel that unsubscribes costs nothing.
 */
export function createSecondClock<THandle>(timer: ClockTimer<THandle>): SecondClock {
  const listeners = new Set<() => void>();
  let handle: THandle | null = null;

  function currentSecond(): number {
    return Math.floor(timer.now() / SECOND_MS) * SECOND_MS;
  }

  function schedule(): void {
    const delay = SECOND_MS - (timer.now() % SECOND_MS) + BOUNDARY_SLACK_MS;
    handle = timer.setTimeout(tick, delay);
  }

  function tick(): void {
    handle = null;
    for (const listener of listeners) listener();
    if (listeners.size > 0) schedule();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (handle === null) schedule();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && handle !== null) {
          timer.clearTimeout(handle);
          handle = null;
        }
      };
    },
    getSnapshot: currentSecond,
  };
}

export const sharedSecondClock = createSecondClock({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
});
