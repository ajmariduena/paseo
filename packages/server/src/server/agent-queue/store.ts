import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AgentAttachmentSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";

const MAX_ENTRIES_PER_AGENT = 200;
const MAX_PROMPT_BYTES = 32 * 1024 * 1024;
const PREVIEW_CHARS = 200;

const QueueOriginSchema = z.enum(["user", "agent", "delegation_wake", "system"]);
const HeldReasonSchema = z.enum(["restart", "failure", "user_stop"]);

const WakeRefSchema = z.object({
  cohortKey: z.string(),
  generation: z.number().int(),
});

const QueueEntrySchema = z.object({
  id: z.string(),
  origin: QueueOriginSchema,
  senderAgentId: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.string(),
  textPreview: z.string(),
  attachmentCount: z.number().int().nonnegative(),
  /** Sidecar holding the full prompt, so images never inflate the queue file. */
  promptFile: z.string().nullable(),
  wake: WakeRefSchema.nullable(),
});

const ClaimSchema = z.object({
  entry: QueueEntrySchema,
  /** The submission attempt the entry was handed to; the claim ends with that attempt's outcome. */
  attemptId: z.string(),
  claimedAt: z.string(),
  /** Set when the attempt's outcome was lost: the entry is held, never replayed on its own. */
  outcome: z.literal("unknown").nullable(),
});

const QueueFileSchema = z.object({
  version: z.literal(1),
  agentId: z.string(),
  held: z.boolean(),
  heldReason: HeldReasonSchema.nullable(),
  entries: z.array(QueueEntrySchema),
  /** Entries handed to a delivery whose native outcome has not settled; absent before claims existed. */
  claims: z.array(ClaimSchema).default([]),
});

const PromptBlockSchema = z.union([
  AgentAttachmentSchema,
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
]);
const PromptSchema = z.union([z.string(), z.array(PromptBlockSchema)]);

export type AgentQueueOrigin = z.infer<typeof QueueOriginSchema>;
export type AgentQueueHeldReason = z.infer<typeof HeldReasonSchema>;
export type AgentQueueEntry = z.infer<typeof QueueEntrySchema>;
export type AgentQueueFile = z.infer<typeof QueueFileSchema>;
export type QueueWakeRef = z.infer<typeof WakeRefSchema>;
export type AgentQueueClaim = z.infer<typeof ClaimSchema>;
export type QueueClaimOutcome = "accepted" | "unsent" | "unknown";

export interface NewQueueEntry {
  id: string;
  origin: AgentQueueOrigin;
  senderAgentId: string | null;
  textPreview: string;
  /** User and agent messages carry their prompt; system entries render theirs at delivery. */
  prompt: AgentPromptInput | null;
  wake: QueueWakeRef | null;
}

export interface DequeuedEntry {
  entry: AgentQueueEntry;
  prompt: AgentPromptInput | null;
}

export class QueueEntryTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Queued message is ${bytes} bytes; the limit is ${MAX_PROMPT_BYTES}`);
    this.name = "QueueEntryTooLargeError";
  }
}

export class QueueFullError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} already has ${MAX_ENTRIES_PER_AGENT} queued messages`);
    this.name = "QueueFullError";
  }
}

export function previewPrompt(prompt: AgentPromptInput): {
  textPreview: string;
  attachmentCount: number;
} {
  if (typeof prompt === "string") {
    return { textPreview: prompt.slice(0, PREVIEW_CHARS), attachmentCount: 0 };
  }
  const text = prompt.find(
    (block): block is { type: "text"; text: string } =>
      block.type === "text" && !("mimeType" in block),
  );
  const attachmentCount = prompt.filter((block) => block !== text).length;
  return { textPreview: (text?.text ?? "").slice(0, PREVIEW_CHARS), attachmentCount };
}

/** Delegation wakes go first, then position: T3 `queuedRunsInDeliveryOrder`. */
export function inDeliveryOrder(entries: readonly AgentQueueEntry[]): AgentQueueEntry[] {
  return [...entries].sort((a, b) => {
    const aWake = a.origin === "delegation_wake" ? 0 : 1;
    const bWake = b.origin === "delegation_wake" ? 0 : 1;
    return aWake - bWake || a.position - b.position;
  });
}

function emptyFile(agentId: string): AgentQueueFile {
  return { version: 1, agentId, held: false, heldReason: null, entries: [], claims: [] };
}

/**
 * Durable per-agent message queue: one JSON file per agent, every method one atomic write of
 * that file (one future SQL transaction). Prompts live in sidecar files written before the
 * queue file references them and deleted after it stops referencing them; an orphan sidecar is
 * removed by `load`. A null directory keeps everything in memory.
 */
export class AgentQueueStore {
  private readonly cache = new Map<string, AgentQueueFile>();
  private readonly memoryPrompts = new Map<string, AgentPromptInput>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string | null) {}

  /** Reads every queue file so `peek` sees agents that are not loaded. Boot only. */
  async load(): Promise<void> {
    const directory = this.directory;
    if (!directory) return;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const agentId = name.slice(0, -".json".length);
      const file = await this.read(agentId);
      if (file) this.cache.set(agentId, file);
      await this.removeOrphanPrompts(agentId, file);
    }
  }

  peek(agentId: string): AgentQueueFile | null {
    return this.cache.get(agentId) ?? null;
  }

  agentIds(): string[] {
    return [...this.cache.keys()];
  }

  async enqueue(agentId: string, input: NewQueueEntry, now: string): Promise<AgentQueueEntry> {
    const promptFile = input.prompt === null ? null : await this.writePrompt(agentId, input.prompt);
    const preview = input.prompt === null ? null : previewPrompt(input.prompt);
    return await this.mutate(agentId, (file) => {
      const existing = file.entries.find((entry) => entry.id === input.id);
      if (existing) return existing;
      if (file.entries.length >= MAX_ENTRIES_PER_AGENT) throw new QueueFullError(agentId);
      const position = Math.max(0, ...file.entries.map((entry) => entry.position)) + 1;
      const entry: AgentQueueEntry = {
        id: input.id,
        origin: input.origin,
        senderAgentId: input.senderAgentId,
        position,
        createdAt: now,
        textPreview: preview?.textPreview ?? input.textPreview.slice(0, PREVIEW_CHARS),
        attachmentCount: preview?.attachmentCount ?? 0,
        promptFile,
        wake: input.wake,
      };
      file.entries.push(entry);
      return entry;
    });
  }

  /** Removes and returns the next entry in delivery order, unless the queue is held. */
  async dequeueNext(agentId: string): Promise<DequeuedEntry | null> {
    const entry = await this.mutate(agentId, (file) => {
      if (file.held) return null;
      const [next] = inDeliveryOrder(file.entries);
      if (!next) return null;
      file.entries = file.entries.filter((candidate) => candidate.id !== next.id);
      return next;
    });
    return entry ? { entry, prompt: await this.readPrompt(agentId, entry) } : null;
  }

  /**
   * Like `dequeueNext`, but the entry and its prompt stay owned by the queue as a claim until
   * `settleClaim` learns the submission outcome. A claim the daemon loses survives a restart.
   */
  async claimNext(agentId: string, attemptId: string, now: string): Promise<DequeuedEntry | null> {
    const entry = await this.mutate(agentId, (file) => {
      if (file.held) return null;
      const [next] = inDeliveryOrder(file.entries);
      if (!next) return null;
      file.entries = file.entries.filter((candidate) => candidate.id !== next.id);
      file.claims.push({ entry: next, attemptId, claimedAt: now, outcome: null });
      return next;
    });
    return entry ? { entry, prompt: await this.readPrompt(agentId, entry) } : null;
  }

  claims(agentId: string): AgentQueueClaim[] {
    return [...(this.cache.get(agentId)?.claims ?? [])];
  }

  /**
   * `accepted` releases the entry for good; `unsent` puts it back and holds the queue, payload
   * intact; `unknown` keeps the claim so nothing replays it on its own.
   */
  async settleClaim(
    agentId: string,
    attemptId: string,
    outcome: QueueClaimOutcome,
  ): Promise<AgentQueueClaim | null> {
    const claim = await this.mutate(agentId, (file) => {
      const found = file.claims.find((candidate) => candidate.attemptId === attemptId) ?? null;
      if (!found) return null;
      if (outcome === "unknown") {
        found.outcome = "unknown";
        return found;
      }
      file.claims = file.claims.filter((candidate) => candidate !== found);
      if (outcome === "unsent") {
        file.entries.push(found.entry);
        file.held = true;
        file.heldReason = "failure";
      }
      return found;
    });
    if (claim && outcome === "accepted") await this.discard(agentId, claim.entry);
    return claim;
  }

  /** Removes one entry, for cancel or promote. Its prompt stays readable until `discard`. */
  async take(agentId: string, entryId: string): Promise<DequeuedEntry | null> {
    const entry = await this.mutate(agentId, (file) => {
      const found = file.entries.find((candidate) => candidate.id === entryId) ?? null;
      file.entries = file.entries.filter((candidate) => candidate.id !== entryId);
      return found;
    });
    return entry ? { entry, prompt: await this.readPrompt(agentId, entry) } : null;
  }

  /** Puts back an entry whose delivery found a newer run, at its old position. */
  async restore(agentId: string, entry: AgentQueueEntry): Promise<void> {
    await this.mutate(agentId, (file) => {
      if (!file.entries.some((candidate) => candidate.id === entry.id)) {
        file.entries.push(entry);
      }
    });
  }

  /** Deletes the prompt of an entry that left the queue for good. */
  async discard(agentId: string, entry: AgentQueueEntry): Promise<void> {
    if (!entry.promptFile) return;
    this.memoryPrompts.delete(promptKey(agentId, entry.promptFile));
    if (this.directory) {
      await rm(this.promptPath(this.directory, agentId, entry.promptFile), { force: true });
    }
  }

  /** Listed entries move to the front in the given order; the rest keep theirs after them. */
  async reorder(agentId: string, entryIds: readonly string[]): Promise<boolean> {
    return await this.mutate(agentId, (file) => {
      if (!entryIds.every((id) => file.entries.some((entry) => entry.id === id))) return false;
      const listed = entryIds.flatMap((id) => file.entries.find((entry) => entry.id === id) ?? []);
      const rest = [...file.entries]
        .filter((entry) => !entryIds.includes(entry.id))
        .sort((a, b) => a.position - b.position);
      file.entries = [...listed, ...rest];
      for (const [index, entry] of file.entries.entries()) {
        entry.position = index + 1;
      }
      return true;
    });
  }

  /** Replaces a queued message's text, keeping its images and attachments. */
  async edit(agentId: string, entryId: string, text: string): Promise<AgentQueueEntry | null> {
    const queued = this.cache.get(agentId) ?? (await this.read(agentId));
    const current = queued?.entries.find((entry) => entry.id === entryId);
    if (!current?.promptFile) return null;
    const previous = await this.readPrompt(agentId, current);
    if (previous === null) return null;
    const prompt = replacePromptText(previous, text);
    const promptFile = await this.writePrompt(agentId, prompt);
    const preview = previewPrompt(prompt);
    const edited = await this.mutate(agentId, (file) => {
      const entry = file.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return null;
      Object.assign(entry, { ...preview, promptFile });
      return { ...entry };
    });
    await this.discard(agentId, edited ? current : { ...current, promptFile });
    return edited;
  }

  /** Holds only a queue with entries: an empty queue has nothing to hold back. */
  async hold(agentId: string, reason: AgentQueueHeldReason): Promise<boolean> {
    return await this.mutate(agentId, (file) => {
      if (file.entries.length === 0 || file.held) return false;
      file.held = true;
      file.heldReason = reason;
      return true;
    });
  }

  async resume(agentId: string): Promise<boolean> {
    return await this.mutate(agentId, (file) => {
      if (!file.held) return false;
      file.held = false;
      file.heldReason = null;
      return true;
    });
  }

  /**
   * After a restart: process-bound system entries are dropped and whatever remains is held
   * until someone resumes it. Returns the dropped entries.
   */
  async holdForRestart(agentId: string): Promise<AgentQueueEntry[]> {
    return await this.mutate(agentId, (file) => {
      const dropped = file.entries.filter((entry) => entry.origin === "system");
      file.entries = file.entries.filter((entry) => entry.origin !== "system");
      file.held = true;
      file.heldReason = "restart";
      return dropped;
    });
  }

  /** Empties the queue and returns what it held. */
  async clear(agentId: string): Promise<AgentQueueEntry[]> {
    const removed = await this.mutate(agentId, (file) => {
      const entries = file.entries;
      file.entries = [];
      return entries;
    });
    for (const entry of removed) await this.discard(agentId, entry);
    return removed;
  }

  private mutate<T>(agentId: string, apply: (file: AgentQueueFile) => T): Promise<T> {
    return this.serialize(agentId, async () => {
      const file = structuredClone(
        this.cache.get(agentId) ?? (await this.read(agentId)) ?? emptyFile(agentId),
      );
      const result = apply(file);
      if (file.entries.length === 0) {
        file.held = false;
        file.heldReason = null;
      }
      await this.write(agentId, file);
      return result;
    });
  }

  private async write(agentId: string, file: AgentQueueFile): Promise<void> {
    const isEmpty = file.entries.length === 0 && file.claims.length === 0;
    if (this.directory) {
      const filePath = this.filePath(this.directory, agentId);
      if (isEmpty) {
        await rm(filePath, { force: true });
      } else {
        // Files without claims keep the shape older daemons wrote.
        const { claims, ...rest } = file;
        await writeJsonFileAtomic(filePath, claims.length > 0 ? file : rest);
      }
    }
    if (isEmpty) {
      this.cache.delete(agentId);
    } else {
      this.cache.set(agentId, file);
    }
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.tails.set(key, result);
    void result
      .finally(() => {
        if (this.tails.get(key) === result) this.tails.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async read(agentId: string): Promise<AgentQueueFile | null> {
    if (!this.directory) return null;
    const raw = await readJson(this.filePath(this.directory, agentId));
    return raw === null ? null : QueueFileSchema.parse(raw);
  }

  private async writePrompt(agentId: string, prompt: AgentPromptInput): Promise<string> {
    const serialized = JSON.stringify(prompt);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_PROMPT_BYTES) throw new QueueEntryTooLargeError(bytes);
    const promptFile = `${randomUUID()}.json`;
    if (this.directory) {
      await writeJsonFileAtomic(this.promptPath(this.directory, agentId, promptFile), prompt);
    } else {
      this.memoryPrompts.set(promptKey(agentId, promptFile), prompt);
    }
    return promptFile;
  }

  private async readPrompt(
    agentId: string,
    entry: AgentQueueEntry,
  ): Promise<AgentPromptInput | null> {
    if (!entry.promptFile) return null;
    if (!this.directory)
      return this.memoryPrompts.get(promptKey(agentId, entry.promptFile)) ?? null;
    const raw = await readJson(this.promptPath(this.directory, agentId, entry.promptFile));
    return raw === null ? null : PromptSchema.parse(raw);
  }

  private async removeOrphanPrompts(agentId: string, file: AgentQueueFile | null): Promise<void> {
    const directory = this.directory;
    if (!directory) return;
    const referenced = new Set([
      ...(file?.entries.flatMap((entry) => entry.promptFile ?? []) ?? []),
      ...(file?.claims.flatMap((claim) => claim.entry.promptFile ?? []) ?? []),
    ]);
    let names: string[];
    try {
      names = await readdir(path.join(directory, agentId));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const name of names) {
      if (!referenced.has(name)) {
        await rm(this.promptPath(directory, agentId, name), { force: true });
      }
    }
  }

  private filePath(directory: string, agentId: string): string {
    return path.join(directory, `${agentId}.json`);
  }

  private promptPath(directory: string, agentId: string, promptFile: string): string {
    return path.join(directory, agentId, promptFile);
  }
}

function replacePromptText(prompt: AgentPromptInput, text: string): AgentPromptInput {
  if (typeof prompt === "string") return text;
  const isPlainText = (block: (typeof prompt)[number]) =>
    block.type === "text" && !("mimeType" in block);
  const index = prompt.findIndex(isPlainText);
  if (index < 0) return [{ type: "text", text }, ...prompt];
  return prompt.map((block, blockIndex) => (blockIndex === index ? { type: "text", text } : block));
}

function promptKey(agentId: string, promptFile: string): string {
  return `${agentId}/${promptFile}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
