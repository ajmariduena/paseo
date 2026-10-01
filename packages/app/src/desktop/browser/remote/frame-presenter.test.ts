import { describe, expect, it } from "vitest";
import type { BrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/index";
import { FramePresenter, type FramePresentation } from "./frame-presenter";

const SUBSCRIPTION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function frame(sequence: number): BrowserScreencastFrame {
  return {
    id: SUBSCRIPTION,
    sequence,
    format: "jpeg",
    snapshot: false,
    metadata: { deviceWidth: 1000 + sequence, deviceHeight: 800 },
    image: new Uint8Array([sequence]),
  };
}

function setup() {
  const acks: number[] = [];
  const released: string[] = [];
  let presentation: FramePresentation | null = null;
  const presenter = new FramePresenter({
    createSource: (f) => {
      const uri = `frame-${f.sequence}`;
      return { uri, release: () => released.push(uri) };
    },
    onChange: (next) => {
      presentation = next;
    },
    ack: (sequence) => acks.push(sequence),
  });
  const uris = () => presentation?.layers.map((layer) => layer?.source.uri ?? null);
  return { presenter, acks, released, uris, visible: () => presentation?.visible };
}

describe("FramePresenter", () => {
  it("shows a frame only after it decodes and then acknowledges it", () => {
    const { presenter, acks, uris } = setup();
    presenter.push(frame(1));
    expect(uris()).toEqual(["frame-1", null]);
    expect(acks).toEqual([]);
    expect(presenter.visibleMetadata).toBeNull();

    presenter.loaded(0, 1);
    expect(acks).toEqual([1]);
    expect(presenter.visibleMetadata?.deviceWidth).toBe(1001);
  });

  it("loads the next frame into the hidden layer and flips after it decodes", () => {
    const { presenter, uris, visible } = setup();
    presenter.push(frame(1));
    presenter.loaded(0, 1);
    presenter.push(frame(2));
    expect(uris()).toEqual(["frame-1", "frame-2"]);
    expect(visible()).toBe(0);
    expect(presenter.visibleMetadata?.deviceWidth).toBe(1001);

    presenter.loaded(1, 2);
    expect(visible()).toBe(1);
    expect(presenter.visibleMetadata?.deviceWidth).toBe(1002);
  });

  it("keeps only the newest frame waiting and acknowledges the one it replaced", () => {
    const { presenter, acks, uris } = setup();
    presenter.push(frame(1));
    presenter.push(frame(2));
    presenter.push(frame(3));
    expect(acks).toEqual([2]);

    presenter.loaded(0, 1);
    expect(uris()).toEqual(["frame-1", "frame-3"]);
    presenter.loaded(1, 3);
    expect(acks).toEqual([2, 1, 3]);
  });

  it("drops a frame that fails to decode and keeps the visible one", () => {
    const { presenter, acks, uris, released } = setup();
    presenter.push(frame(1));
    presenter.loaded(0, 1);
    presenter.push(frame(2));
    presenter.failed(1, 2);
    expect(uris()).toEqual(["frame-1", null]);
    expect(released).toEqual(["frame-2"]);
    expect(acks).toEqual([1, 2]);
  });

  it("ignores stale load events", () => {
    const { presenter, acks } = setup();
    presenter.push(frame(1));
    presenter.loaded(1, 1);
    presenter.loaded(0, 9);
    expect(acks).toEqual([]);
  });

  it("clears every image and acknowledges frames still in flight", () => {
    const { presenter, acks, uris, released } = setup();
    presenter.push(frame(1));
    presenter.loaded(0, 1);
    presenter.push(frame(2));
    presenter.push(frame(3));
    presenter.clear();
    expect(uris()).toEqual([null, null]);
    expect(acks).toEqual([1, 3, 2]);
    expect(released).toEqual(["frame-1", "frame-2"]);
  });
});
