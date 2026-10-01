import type { BrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/index";
import type { FrameSource } from "./frame-source";

export function createFrameSource(frame: BrowserScreencastFrame): FrameSource {
  const uri = URL.createObjectURL(
    new Blob([frame.image.slice()], { type: `image/${frame.format}` }),
  );
  return { uri, release: () => URL.revokeObjectURL(uri) };
}
