import { describe, expect, it } from "vitest";
import { fitFrame, paneDragToWheel, panePointToPage } from "./geometry";

describe("remote browser geometry", () => {
  it("letterboxes a landscape desktop viewport into a portrait pane", () => {
    const fit = fitFrame({ width: 390, height: 600 }, { deviceWidth: 1280, deviceHeight: 800 });
    expect(fit).toMatchObject({ renderedWidth: 390, offsetX: 0 });
    expect(fit?.renderedHeight).toBeCloseTo(243.75);
    expect(fit?.offsetY).toBeCloseTo(178.125);
  });

  it("maps a tap through the letterbox to viewport CSS pixels", () => {
    const fit = fitFrame({ width: 390, height: 600 }, { deviceWidth: 1280, deviceHeight: 800 });
    expect(panePointToPage(195, 300, fit)).toEqual({ x: 640, y: 400 });
    expect(panePointToPage(0, 178.125, fit)).toEqual({ x: 0, y: 0 });
  });

  it("ignores taps on the letterbox bars", () => {
    const fit = fitFrame({ width: 390, height: 600 }, { deviceWidth: 1280, deviceHeight: 800 });
    expect(panePointToPage(100, 20, fit)).toBeNull();
    expect(panePointToPage(100, 590, fit)).toBeNull();
  });

  it("does not add the page scroll offset to viewport taps", () => {
    const fit = fitFrame(
      { width: 640, height: 400 },
      { deviceWidth: 1280, deviceHeight: 800, scrollOffsetY: 2000 },
    );
    expect(panePointToPage(320, 200, fit)).toEqual({ x: 640, y: 400 });
  });

  it("divides by the page scale of a zoomed page", () => {
    const fit = fitFrame(
      { width: 640, height: 400 },
      { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 2 },
    );
    expect(panePointToPage(640, 400, fit)).toEqual({ x: 640, y: 400 });
    expect(panePointToPage(320, 200, fit)).toEqual({ x: 320, y: 200 });
  });

  it("scrolls the visible distance of a drag, inverted like a wheel", () => {
    const fit = fitFrame({ width: 640, height: 400 }, { deviceWidth: 1280, deviceHeight: 800 });
    expect(paneDragToWheel(0, -50, fit)).toEqual({ deltaX: 0, deltaY: 100 });
    expect(paneDragToWheel(10, 0, fit)).toEqual({ deltaX: -20, deltaY: 0 });
  });

  it("has no fit before the pane is measured or a frame arrives", () => {
    expect(fitFrame(null, { deviceWidth: 1, deviceHeight: 1 })).toBeNull();
    expect(fitFrame({ width: 0, height: 10 }, { deviceWidth: 1, deviceHeight: 1 })).toBeNull();
    expect(fitFrame({ width: 10, height: 10 }, null)).toBeNull();
    expect(panePointToPage(1, 1, null)).toBeNull();
  });
});
