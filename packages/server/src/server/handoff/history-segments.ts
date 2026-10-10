import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { HandoffBlobSchema } from "@getpaseo/protocol/handoff";
import { readBoundedFile } from "./artifacts.js";

export const HANDOFF_PREVIOUS_SEGMENTS_MAX = 32;
export const HANDOFF_HISTORY_INDEX_MAX_BYTES = 1024 * 1024;
export const HandoffHistoryOriginSchema = z.object({
  sourceServerId: z.string().min(1).max(512),
  sourceWorkspaceId: z.string().min(1).max(512),
  sourceAgentId: z.string().min(1).max(512),
  sourceCwd: z.string().min(1).max(8192),
});
export const HandoffHistorySegmentSchema = z.object({
  origin: HandoffHistoryOriginSchema,
  history: HandoffBlobSchema,
  session: HandoffBlobSchema,
});
export const HandoffHistoryIndexSchema = z.object({
  version: z.literal(1),
  segments: z
    .array(HandoffHistorySegmentSchema)
    .min(1)
    .max(HANDOFF_PREVIOUS_SEGMENTS_MAX + 1),
});
export type HandoffHistorySegment = z.infer<typeof HandoffHistorySegmentSchema>;

export function validateHistorySegments(segments: HandoffHistorySegment[]): void {
  HandoffHistoryIndexSchema.parse({ version: 1, segments });
  if (new Set(segments.map((segment) => segment.history.sha256)).size !== segments.length)
    throw new Error("Duplicate conversation history segment");
}

export function historySegmentDirectory(segment: HandoffHistorySegment, current: boolean): string {
  return current ? "" : `previous/${segment.history.sha256}/`;
}

export async function readHistoryIndex(file: string, expected?: HandoffHistorySegment[]) {
  const bytes = await readBoundedFile(file, HANDOFF_HISTORY_INDEX_MAX_BYTES);
  const index = HandoffHistoryIndexSchema.parse(JSON.parse(bytes.toString("utf8")));
  validateHistorySegments(index.segments);
  if (expected && !isDeepStrictEqual(index.segments, expected))
    throw new Error("Conversation history index differs from its verified segments");
  return index;
}
