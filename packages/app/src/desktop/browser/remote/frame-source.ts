import { Buffer } from "buffer";
import type { BrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/index";

export interface FrameSource {
  uri: string;
  release(): void;
}

export function createFrameSource(frame: BrowserScreencastFrame): FrameSource {
  return {
    uri: `data:image/${frame.format};base64,${Buffer.from(frame.image).toString("base64")}`,
    release: () => {},
  };
}
