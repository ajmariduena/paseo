import type { BrowserScreencastFrameMetadata } from "@getpaseo/protocol/binary-frames/index";

export interface PaneSize {
  width: number;
  height: number;
}

export interface FrameFit {
  /** Page viewport in device-independent pixels, as the frame was painted. */
  sourceWidth: number;
  sourceHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
  /** Pane points per frame DIP. */
  scale: number;
  pageScale: number;
}

export function fitFrame(
  pane: PaneSize | null,
  metadata: BrowserScreencastFrameMetadata | null,
): FrameFit | null {
  if (!pane || !metadata || pane.width <= 0 || pane.height <= 0) return null;
  const sourceWidth = metadata.deviceWidth;
  const sourceHeight = metadata.deviceHeight;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
  const scale = Math.min(pane.width / sourceWidth, pane.height / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  return {
    sourceWidth,
    sourceHeight,
    renderedWidth,
    renderedHeight,
    offsetX: (pane.width - renderedWidth) / 2,
    offsetY: (pane.height - renderedHeight) / 2,
    scale,
    pageScale:
      metadata.pageScaleFactor && metadata.pageScaleFactor > 0 ? metadata.pageScaleFactor : 1,
  };
}

/**
 * Maps a pane point to the page CSS pixels that CDP input expects. The frame is the visual
 * viewport, so scroll offsets are never added: input coordinates are viewport-relative.
 */
export function panePointToPage(
  x: number,
  y: number,
  fit: FrameFit | null,
): { x: number; y: number } | null {
  if (!fit) return null;
  const localX = x - fit.offsetX;
  const localY = y - fit.offsetY;
  if (localX < 0 || localY < 0 || localX > fit.renderedWidth || localY > fit.renderedHeight) {
    return null;
  }
  const pageWidth = fit.sourceWidth / fit.pageScale;
  const pageHeight = fit.sourceHeight / fit.pageScale;
  return {
    x: clamp(Math.round((localX / fit.renderedWidth) * pageWidth), 0, pageWidth),
    y: clamp(Math.round((localY / fit.renderedHeight) * pageHeight), 0, pageHeight),
  };
}

/** A finger drag as the wheel delta that scrolls the page the same visible distance. */
export function paneDragToWheel(
  dx: number,
  dy: number,
  fit: FrameFit | null,
): { deltaX: number; deltaY: number } {
  const scale = fit ? fit.scale * fit.pageScale : 1;
  return { deltaX: roundDelta(-dx / scale), deltaY: roundDelta(-dy / scale) };
}

function roundDelta(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
