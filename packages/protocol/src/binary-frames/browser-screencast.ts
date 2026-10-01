export const BrowserScreencastOpcode = {
  Frame: 0x20,
} as const;

export const BROWSER_SCREENCAST_FRAME_VERSION = 1;
export const BROWSER_SCREENCAST_MAX_METADATA_BYTES = 4 * 1024;
export const BROWSER_SCREENCAST_MAX_IMAGE_BYTES = 1024 * 1024;

const HEADER_BYTES = 30;
const ID_OFFSET = 4;
const ID_BYTES = 16;
const SNAPSHOT_FLAG = 0b1;

export type BrowserScreencastImageFormat = "jpeg" | "png";

export interface BrowserScreencastFrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  offsetTop?: number;
  timestamp?: number;
}

export interface BrowserScreencastFrame {
  /** Host stream ID on host→daemon frames; viewer subscription ID on daemon→viewer frames. */
  id: string;
  sequence: number;
  format: BrowserScreencastImageFormat;
  snapshot: boolean;
  metadata: BrowserScreencastFrameMetadata;
  image: Uint8Array;
}

const FORMAT_CODES: Record<BrowserScreencastImageFormat, number> = { jpeg: 1, png: 2 };
const FORMATS_BY_CODE: Partial<Record<number, BrowserScreencastImageFormat>> = {
  1: "jpeg",
  2: "png",
};
const METADATA_KEYS = [
  "deviceWidth",
  "deviceHeight",
  "pageScaleFactor",
  "scrollOffsetX",
  "scrollOffsetY",
  "offsetTop",
  "timestamp",
] as const;
const MAX_DIMENSION = 100_000;

export function encodeBrowserScreencastFrame(frame: BrowserScreencastFrame): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(pickMetadata(frame.metadata)));
  if (metadata.byteLength > BROWSER_SCREENCAST_MAX_METADATA_BYTES) {
    throw new RangeError("Browser screencast metadata is too long");
  }
  if (frame.image.byteLength > BROWSER_SCREENCAST_MAX_IMAGE_BYTES) {
    throw new RangeError("Browser screencast image is too large");
  }
  const bytes = new Uint8Array(HEADER_BYTES + metadata.byteLength + frame.image.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[0] = BrowserScreencastOpcode.Frame;
  bytes[1] = BROWSER_SCREENCAST_FRAME_VERSION;
  bytes[2] = FORMAT_CODES[frame.format];
  bytes[3] = frame.snapshot ? SNAPSHOT_FLAG : 0;
  bytes.set(uuidToBytes(frame.id), ID_OFFSET);
  view.setUint32(20, frame.sequence >>> 0, true);
  view.setUint16(24, metadata.byteLength, true);
  view.setUint32(26, frame.image.byteLength, true);
  bytes.set(metadata, HEADER_BYTES);
  bytes.set(frame.image, HEADER_BYTES + metadata.byteLength);
  return bytes;
}

export function decodeBrowserScreencastFrame(bytes: Uint8Array): BrowserScreencastFrame | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  if (bytes[0] !== BrowserScreencastOpcode.Frame) return null;
  if (bytes[1] !== BROWSER_SCREENCAST_FRAME_VERSION) return null;
  const format = FORMATS_BY_CODE[bytes[2]];
  if (!format) return null;
  if ((bytes[3] & ~SNAPSHOT_FLAG) !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataLength = view.getUint16(24, true);
  const imageLength = view.getUint32(26, true);
  if (metadataLength > BROWSER_SCREENCAST_MAX_METADATA_BYTES) return null;
  if (imageLength === 0 || imageLength > BROWSER_SCREENCAST_MAX_IMAGE_BYTES) return null;
  if (bytes.byteLength !== HEADER_BYTES + metadataLength + imageLength) return null;
  const metadata = parseMetadata(bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength));
  if (!metadata) return null;
  return {
    id: bytesToUuid(bytes.subarray(ID_OFFSET, ID_OFFSET + ID_BYTES)),
    sequence: view.getUint32(20, true),
    format,
    snapshot: (bytes[3] & SNAPSHOT_FLAG) !== 0,
    metadata,
    image: bytes.subarray(HEADER_BYTES + metadataLength),
  };
}

/** Copies a validated frame with a different routing ID; the encoded image is not touched. */
export function readdressBrowserScreencastFrame(bytes: Uint8Array, id: string): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy.set(uuidToBytes(id), ID_OFFSET);
  return copy;
}

function pickMetadata(metadata: BrowserScreencastFrameMetadata): BrowserScreencastFrameMetadata {
  const picked: Record<string, number> = {};
  for (const key of METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) picked[key] = value;
  }
  return picked as unknown as BrowserScreencastFrameMetadata;
}

function parseMetadata(bytes: Uint8Array): BrowserScreencastFrameMetadata | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const metadata: Record<string, number> = {};
  for (const key of METADATA_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15) {
      return null;
    }
    metadata[key] = value;
  }
  if (!isDimension(metadata.deviceWidth) || !isDimension(metadata.deviceHeight)) return null;
  if (metadata.pageScaleFactor !== undefined && !(metadata.pageScaleFactor > 0)) return null;
  return metadata as unknown as BrowserScreencastFrameMetadata;
}

function isDimension(value: number | undefined): boolean {
  return value !== undefined && value > 0 && value <= MAX_DIMENSION;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBrowserScreencastId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function uuidToBytes(id: string): Uint8Array {
  if (!UUID_PATTERN.test(id)) throw new RangeError("Browser screencast IDs must be UUIDs");
  const hex = id.replaceAll("-", "");
  const bytes = new Uint8Array(ID_BYTES);
  for (let index = 0; index < ID_BYTES; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
