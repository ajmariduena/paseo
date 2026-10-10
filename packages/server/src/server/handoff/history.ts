import { z } from "zod";
import { createHash } from "node:crypto";
import path from "node:path";
import { HandoffBlobSchema, type HandoffBlob } from "@getpaseo/protocol/handoff";
import { PromptAnnotationCheckpointSchema } from "../agent/prompt-annotations.js";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { InMemoryAgentTimelineStore } from "../agent/agent-timeline-store.js";
import type { AgentTimelineFetchOptions } from "../agent/agent-timeline-store-types.js";
import { readBoundedFile, writeJournal } from "./artifacts.js";

export const HANDOFF_HISTORY_MAX_BYTES = 64 * 1024 * 1024;
export const HandoffHistorySchema = z.object({
  version: z.literal(1),
  sourceAgentId: z.string().min(1).max(512),
  epoch: z.string().uuid(),
  promptAnnotations: PromptAnnotationCheckpointSchema.optional(),
  rows: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        timestamp: z.string().datetime(),
        item: AgentTimelineItemPayloadSchema,
        turnId: z.string().optional(),
        providerMessageId: z.string().optional(),
      }),
    )
    .max(100_000),
});
export type HandoffHistory = z.infer<typeof HandoffHistorySchema>;

export async function readRetainedHandoffHistory(
  directory: string,
  agentId: string,
  history: HandoffBlob,
): Promise<HandoffHistory> {
  const blob = HandoffBlobSchema.parse(history);
  const bytes = await readBoundedFile(
    path.join(directory, "retained", `${blob.sha256}.json`),
    HANDOFF_HISTORY_MAX_BYTES,
  );
  if (
    bytes.length !== blob.size ||
    createHash("sha256").update(bytes).digest("hex") !== blob.sha256
  )
    throw new Error("Retained conversation history is damaged");
  return parseHandoffHistory(bytes, agentId);
}

export function lastHandoffAssistantMessage(history: HandoffHistory): string | null {
  const chunks: string[] = [];
  for (const row of history.rows.toReversed()) {
    if (row.item.type === "assistant_message") chunks.push(row.item.text);
    else if (chunks.length) break;
  }
  return chunks.length ? chunks.toReversed().join("") : null;
}

export async function writeHandoffHistory(file: string, history: HandoffHistory): Promise<void> {
  const parsed = HandoffHistorySchema.parse(history);
  if (Buffer.byteLength(JSON.stringify(parsed)) > HANDOFF_HISTORY_MAX_BYTES)
    throw new Error("Handoff history exceeds its byte limit");
  await writeJournal(file, parsed);
}

export async function readHandoffHistory(
  file: string,
  sourceAgentId: string,
): Promise<HandoffHistory> {
  const bytes = await readBoundedFile(file, HANDOFF_HISTORY_MAX_BYTES);
  return parseHandoffHistory(bytes, sourceAgentId);
}

export function parseHandoffHistory(bytes: Buffer, sourceAgentId: string): HandoffHistory {
  const history = HandoffHistorySchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    history.sourceAgentId !== sourceAgentId ||
    history.rows.some((row, index) => row.seq !== index + 1)
  )
    throw new Error("Handoff history belongs to another conversation or has missing rows");
  return history;
}

export function fetchHandoffHistory(history: HandoffHistory, options: AgentTimelineFetchOptions) {
  const store = new InMemoryAgentTimelineStore();
  store.initialize(history.sourceAgentId, { epoch: history.epoch, rows: history.rows });
  return store.fetch(history.sourceAgentId, options);
}
