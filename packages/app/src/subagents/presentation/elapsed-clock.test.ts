import { describe, expect, it } from "vitest";
import { createSecondClock, type ClockTimer } from "./elapsed-clock";

interface PendingTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

function createManualTimer(startMs: number) {
  let now = startMs;
  let nextId = 1;
  let pending: PendingTimer[] = [];
  const timer: ClockTimer<number> = {
    now: () => now,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      pending.push({ id, dueAt: now + delayMs, callback });
      return id;
    },
    clearTimeout(handle) {
      pending = pending.filter((entry) => entry.id !== handle);
    },
  };
  return {
    timer,
    pendingCount: () => pending.length,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = pending
          .filter((entry) => entry.dueAt <= target)
          .sort((left, right) => left.dueAt - right.dueAt)[0];
        if (!due) break;
        pending = pending.filter((entry) => entry.id !== due.id);
        now = due.dueAt;
        due.callback();
      }
      now = target;
    },
  };
}

describe("createSecondClock", () => {
  it("reports the floored wall-clock second", () => {
    const manual = createManualTimer(10_400);
    const clock = createSecondClock(manual.timer);
    expect(clock.getSnapshot()).toBe(10_000);
  });

  it("does not run without listeners", () => {
    const manual = createManualTimer(0);
    createSecondClock(manual.timer);
    expect(manual.pendingCount()).toBe(0);
  });

  it("notifies every listener once per second boundary with one timer", () => {
    const manual = createManualTimer(10_400);
    const clock = createSecondClock(manual.timer);
    const seen: number[] = [];
    clock.subscribe(() => seen.push(clock.getSnapshot()));
    clock.subscribe(() => undefined);
    expect(manual.pendingCount()).toBe(1);

    manual.advance(2_700);

    expect(seen).toEqual([11_000, 12_000, 13_000]);
    expect(manual.pendingCount()).toBe(1);
  });

  it("stops when the last listener leaves", () => {
    const manual = createManualTimer(0);
    const clock = createSecondClock(manual.timer);
    const first = clock.subscribe(() => undefined);
    const second = clock.subscribe(() => undefined);

    first();
    expect(manual.pendingCount()).toBe(1);
    second();
    expect(manual.pendingCount()).toBe(0);
  });
});
