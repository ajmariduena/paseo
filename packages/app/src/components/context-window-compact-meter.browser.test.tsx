import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactableMeter, type ContextWindowCompaction } from "./context-window-compact-meter";
import {
  formatSessionCost,
  getMeterGeometry,
  resolveMeterUsage,
  resolveTriggerStyle,
} from "./context-window-ring";

const onCompact = vi.fn();
const COMPACTION: ContextWindowCompaction = { timing: "now", onCompact };

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  onCompact.mockClear();
});

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function byTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

function meter(): HTMLElement {
  const element = byTestId("context-window-meter");
  if (!element) throw new Error("context window meter did not render");
  return element;
}

function compactMeterProps(usedTokens: number, totalCostUsd?: number) {
  const usage = resolveMeterUsage(200_000, usedTokens);
  if (!usage) throw new Error("expected usage");
  const geometry = getMeterGeometry(false, 20);
  return {
    usage,
    sessionCost: totalCostUsd === undefined ? null : formatSessionCost(totalCostUsd),
    triggerStyle: resolveTriggerStyle(geometry, usage, false),
    ring: { usage, geometry, showPercentage: false, pending: false },
    compaction: COMPACTION,
  };
}

describe("context window compact meter", () => {
  it("shows the percentage once the window is 75% used", () => {
    mount(<CompactableMeter {...compactMeterProps(164_000)} />);
    expect(meter().textContent).toBe("82%");
  });

  it("stays a bare ring below 75%", () => {
    mount(<CompactableMeter {...compactMeterProps(100_000)} />);
    expect(meter().textContent).toBe("");
  });

  it("opens the context panel and hands the compact press to the caller after closing", () => {
    mount(<CompactableMeter {...compactMeterProps(164_000, 3.41)} />);

    click(meter());
    const button = byTestId("context-window-compact");
    expect(button).not.toBeNull();
    expect(byTestId("context-window-panel")?.textContent).toContain("$3.41");

    click(button as HTMLElement);

    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(byTestId("context-window-compact")).toBeNull();
  });
});
