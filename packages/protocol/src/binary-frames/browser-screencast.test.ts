import { describe, expect, test } from "vitest";
import {
  BROWSER_SCREENCAST_MAX_IMAGE_BYTES,
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastFrame,
  readdressBrowserScreencastFrame,
  type BrowserScreencastFrame,
} from "./browser-screencast.js";
import { decodeBinaryFrame } from "./demux.js";

const STREAM_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const VIEWER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function frame(overrides: Partial<BrowserScreencastFrame> = {}): BrowserScreencastFrame {
  return {
    id: STREAM_ID,
    sequence: 42,
    format: "jpeg",
    snapshot: true,
    metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, scrollOffsetY: 120 },
    image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    ...overrides,
  };
}

function corrupt(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[offset] = value;
  return copy;
}

describe("browser screencast frames", () => {
  test("round-trips a frame through the binary demuxer", () => {
    const bytes = encodeBrowserScreencastFrame(frame());
    const decoded = decodeBinaryFrame(bytes);
    expect(decoded?.kind).toBe("browser_screencast");
    if (decoded?.kind !== "browser_screencast") return;
    expect(decoded.frame).toEqual(frame());
  });

  test("readdresses a frame without touching the image", () => {
    const bytes = encodeBrowserScreencastFrame(frame());
    const readdressed = readdressBrowserScreencastFrame(bytes, VIEWER_ID);
    expect(decodeBrowserScreencastFrame(readdressed)).toEqual(frame({ id: VIEWER_ID }));
    expect(decodeBrowserScreencastFrame(bytes)?.id).toBe(STREAM_ID);
  });

  test("drops metadata keys outside the contract", () => {
    const bytes = encodeBrowserScreencastFrame(
      frame({
        metadata: { deviceWidth: 10, deviceHeight: 10, extra: 1 } as never,
      }),
    );
    expect(decodeBrowserScreencastFrame(bytes)?.metadata).toEqual({
      deviceWidth: 10,
      deviceHeight: 10,
    });
  });

  test("rejects unknown versions, formats, and flags", () => {
    const bytes = encodeBrowserScreencastFrame(frame());
    expect(decodeBrowserScreencastFrame(corrupt(bytes, 1, 2))).toBeNull();
    expect(decodeBrowserScreencastFrame(corrupt(bytes, 2, 9))).toBeNull();
    expect(decodeBrowserScreencastFrame(corrupt(bytes, 3, 0b10))).toBeNull();
  });

  test("rejects inconsistent lengths and truncated frames", () => {
    const bytes = encodeBrowserScreencastFrame(frame());
    expect(decodeBrowserScreencastFrame(bytes.subarray(0, bytes.byteLength - 1))).toBeNull();
    expect(decodeBrowserScreencastFrame(bytes.subarray(0, 12))).toBeNull();
    const longer = new Uint8Array(bytes.byteLength + 1);
    longer.set(bytes);
    expect(decodeBrowserScreencastFrame(longer)).toBeNull();
  });

  test("rejects invalid dimensions and non-numeric metadata", () => {
    const encode = (metadata: string) => {
      const json = new TextEncoder().encode(metadata);
      const image = new Uint8Array([1]);
      const bytes = encodeBrowserScreencastFrame(frame({ image }));
      const header = bytes.subarray(0, 30);
      const out = new Uint8Array(30 + json.byteLength + image.byteLength);
      out.set(header);
      new DataView(out.buffer).setUint16(24, json.byteLength, true);
      out.set(json, 30);
      out.set(image, 30 + json.byteLength);
      return out;
    };
    expect(decodeBrowserScreencastFrame(encode('{"deviceWidth":0,"deviceHeight":10}'))).toBeNull();
    expect(
      decodeBrowserScreencastFrame(encode('{"deviceWidth":"10","deviceHeight":10}')),
    ).toBeNull();
    expect(decodeBrowserScreencastFrame(encode("[]"))).toBeNull();
    expect(decodeBrowserScreencastFrame(encode("not json"))).toBeNull();
    expect(
      decodeBrowserScreencastFrame(encode('{"deviceWidth":10,"deviceHeight":10}')),
    ).not.toBeNull();
  });

  test("refuses to encode an oversized image", () => {
    expect(() =>
      encodeBrowserScreencastFrame(
        frame({ image: new Uint8Array(BROWSER_SCREENCAST_MAX_IMAGE_BYTES + 1) }),
      ),
    ).toThrow(RangeError);
  });
});
