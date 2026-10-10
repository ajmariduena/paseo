import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  AgentAttachmentSchema,
  type UploadedFileAttachment,
  type ReviewAttachment,
} from "@getpaseo/protocol/messages";
import { formatPeerMessage, parsePeerMessage } from "@getpaseo/protocol/peer-message";
import { z } from "zod";

import { syncFilePublication, writeJsonFileAtomic } from "../atomic-file.js";
import { readBoundedFile } from "../handoff/artifacts.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { formatAgentMessage, parseAgentMessage } from "../agent/agent-messages/index.js";
import {
  CapturedUploadSchema,
  parseCapturedUpload,
  type CapturedUpload,
  type FileUploadStore,
} from "../file-upload/index.js";

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

const QueueFileSchema = z.object({
  version: z.literal(1),
  agentId: z.string(),
  held: z.boolean(),
  heldReason: HeldReasonSchema.nullable(),
  entries: z.array(QueueEntrySchema),
  handoff: z.object({ reservationId: z.string(), digest: z.string() }).optional(),
});

const PromptBlockSchema = z.union([
  AgentAttachmentSchema,
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
]);
const PromptSchema = z.union([z.string(), z.array(PromptBlockSchema)]);

export const HANDOFF_QUEUE_MAX_BYTES = 64 * 1024 * 1024;
const HandoffQueueSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  files: z.array(CapturedUploadSchema).max(2000).optional(),
  entries: z
    .array(
      z.object({
        id: z.string().min(1).max(512),
        origin: z.enum(["user", "agent"]),
        senderAgentId: z.string().min(1).max(512).nullable(),
        createdAt: z.string().min(1).max(128),
        prompt: PromptSchema,
      }),
    )
    .max(MAX_ENTRIES_PER_AGENT),
});
export type HandoffQueue = z.infer<typeof HandoffQueueSchema>;

export function parseHandoffQueue(value: unknown): HandoffQueue {
  const snapshot = HandoffQueueSchema.parse(value);
  if (handoffQueueBytes(snapshot) > HANDOFF_QUEUE_MAX_BYTES)
    throw new Error("Queued messages exceed the handoff byte limit");
  validateQueueUploads(snapshot);
  const ids = new Set<string>();
  for (const entry of snapshot.entries) {
    if (ids.has(entry.id)) throw new Error("Duplicate queued message in handoff");
    ids.add(entry.id);
    if ((entry.origin === "agent") !== (entry.senderAgentId !== null))
      throw new Error("Queued message sender does not match its origin");
    remapHandoffQueueEntry(entry);
    const bytes = Buffer.byteLength(JSON.stringify(entry.prompt));
    if (bytes > MAX_PROMPT_BYTES) throw new QueueEntryTooLargeError(bytes);
    if (typeof entry.prompt === "string") continue;
    for (const block of entry.prompt) {
      if (block.type === "review") validateReviewPaths(block);
    }
  }
  return snapshot;
}

function validateReviewPaths(review: ReviewAttachment): void {
  if (!path.posix.isAbsolute(review.cwd) || review.cwd.includes("\\") || review.cwd.includes("\0"))
    throw new Error("Queued review needs an absolute workspace directory");
  for (const { filePath } of review.comments) {
    if (
      !filePath ||
      filePath.includes("\\") ||
      filePath.includes("\0") ||
      path.posix.isAbsolute(filePath) ||
      path.win32.isAbsolute(filePath) ||
      filePath.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      throw new Error("Queued review file path must stay relative to its workspace");
  }
}

function queueReviews(entries: HandoffQueue["entries"]): ReviewAttachment[] {
  return entries.flatMap(({ prompt }) =>
    typeof prompt === "string"
      ? []
      : prompt.filter((block): block is ReviewAttachment => block.type === "review"),
  );
}

export function assertHandoffQueueWorkspace(snapshot: HandoffQueue, sourceCwd: string): void {
  for (const review of queueReviews(snapshot.entries)) {
    if (review.cwd !== sourceCwd)
      throw new Error(
        "Queued review belongs to a different source workspace. Remove that review before moving this workspace.",
      );
  }
}

async function captureHandoffReviews(
  entries: HandoffQueue["entries"],
  workspaceCwd?: string,
): Promise<void> {
  const reviews = queueReviews(entries);
  if (!reviews.length) return;
  if (!workspaceCwd) throw new Error("Queued review requires its source workspace");
  const source = await realpath(workspaceCwd);
  for (const review of reviews) {
    validateReviewPaths(review);
    const directory = await realpath(review.cwd);
    if (!(await stat(directory)).isDirectory())
      throw new Error("Queued review working directory is not a directory");
    const relative = path.relative(source, directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(
        "Queued review belongs to a different source workspace. Remove that review before moving this workspace.",
      );
    // Review snippets can describe deleted files. Resolve the review directory only;
    // keep the comments, baseline label and captured lines as historical input.
    review.cwd = source;
    const prefix = relative.split(path.sep).join("/");
    for (const comment of review.comments)
      comment.filePath = path.posix.join(prefix, comment.filePath);
  }
}

export function handoffQueueBytes(snapshot: HandoffQueue): number {
  const blobs = new Map((snapshot.files ?? []).map(({ blob }) => [blob.sha256, blob.size]));
  return (
    Buffer.byteLength(JSON.stringify(snapshot)) +
    [...blobs.values()].reduce((total, size) => total + size, 0)
  );
}

function queuedUploads(entries: HandoffQueue["entries"]): UploadedFileAttachment[] {
  return entries.flatMap(({ prompt }) =>
    typeof prompt === "string"
      ? []
      : prompt.filter((block): block is UploadedFileAttachment => block.type === "uploaded_file"),
  );
}

function validateQueueUploads(snapshot: HandoffQueue): void {
  const files = snapshot.files ?? [];
  if ((snapshot.version === 2) !== files.length > 0)
    throw new Error("Queued upload bytes require queue version 2");
  const references = new Map(
    queuedUploads(snapshot.entries).map((attachment) => [attachment.path, attachment]),
  );
  if (files.length !== references.size)
    throw new Error("Queued upload inventory differs from its prompt references");
  const paths = new Set<string>();
  const blobs = new Map<string, number>();
  for (const { attachment, blob } of files) {
    parseCapturedUpload({ attachment, blob });
    if (
      paths.has(attachment.path) ||
      !isDeepStrictEqual(references.get(attachment.path), attachment) ||
      blob.size !== attachment.size ||
      (blobs.has(blob.sha256) && blobs.get(blob.sha256) !== blob.size)
    )
      throw new Error("Queued upload inventory differs from its prompt references");
    paths.add(attachment.path);
    blobs.set(blob.sha256, blob.size);
  }
  for (const attachment of queuedUploads(snapshot.entries)) {
    if (!isDeepStrictEqual(references.get(attachment.path), attachment))
      throw new Error("Queued upload references conflict");
  }
}

export async function readHandoffQueue(filePath: string): Promise<HandoffQueue> {
  return parseHandoffQueue(
    JSON.parse((await readBoundedFile(filePath, HANDOFF_QUEUE_MAX_BYTES)).toString("utf8")),
  );
}

/** Rewrite only the structured delivery envelope; the submitted message body stays intact. */
export function remapHandoffQueueEntry(
  entry: HandoffQueue["entries"][number],
  senderAgentId = entry.senderAgentId,
  id = entry.id,
): HandoffQueue["entries"][number] {
  function text(value: string): string {
    const message = parseAgentMessage(value);
    if (message) {
      if (
        message.id !== entry.id ||
        (message.source?.agentId ?? null) !== entry.senderAgentId ||
        message.source?.kind === "agent-notification"
      )
        throw new Error("Queued message envelope differs from its delivery identity");
      return formatAgentMessage({
        ...message,
        id,
        source:
          message.source && senderAgentId ? { ...message.source, agentId: senderAgentId } : null,
      });
    }
    // COMPAT(handoffPeerEnvelope): added in v0.11.1, remove after 2027-04-10 once legacy peer queues drain.
    const peer = entry.senderAgentId ? parsePeerMessage(value) : null;
    if (!peer) return value;
    if (peer.sender.agentId !== entry.senderAgentId || !senderAgentId)
      throw new Error("Queued peer envelope differs from its sender identity");
    return formatPeerMessage({ ...peer, sender: { ...peer.sender, agentId: senderAgentId } });
  }
  const prompt =
    typeof entry.prompt === "string"
      ? text(entry.prompt)
      : entry.prompt.map((block) =>
          block.type === "text" && !("mimeType" in block)
            ? { type: "text" as const, text: text(block.text) }
            : block,
        );
  return { ...entry, id, senderAgentId, prompt };
}

export type AgentQueueOrigin = z.infer<typeof QueueOriginSchema>;
export type AgentQueueHeldReason = z.infer<typeof HeldReasonSchema>;
export type AgentQueueEntry = z.infer<typeof QueueEntrySchema>;
export type AgentQueueFile = z.infer<typeof QueueFileSchema>;
export type QueueWakeRef = z.infer<typeof WakeRefSchema>;

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
  return { version: 1, agentId, held: false, heldReason: null, entries: [] };
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

  constructor(
    private readonly directory: string | null,
    private readonly options: {
      sync?: typeof syncFilePublication;
      uploads?: Pick<FileUploadStore, "captureForHandoff" | "installForHandoff">;
    } = {},
  ) {}

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

  /** A capture must describe the durable queue, including every referenced prompt. */
  async exportForHandoff(
    agentId: string,
    options: {
      requireHeld?: boolean;
      ignoreSystemIds?: readonly string[];
      blobsDirectory?: string;
      workspaceCwd?: string;
    } = {},
  ): Promise<HandoffQueue> {
    return this.serialize(agentId, async () => {
      const cached = this.cache.get(agentId) ?? null;
      const stored = this.directory ? await this.readHandoffFile(agentId) : cached;
      if (!isDeepStrictEqual(cached, stored))
        throw new Error("Queued messages differ from durable storage");
      const entries: HandoffQueue["entries"] = [];
      let bytes = 0;
      for (const entry of inDeliveryOrder(stored?.entries ?? [])) {
        if (entry.origin === "system" && options.ignoreSystemIds?.includes(entry.id)) continue;
        if (entry.origin !== "user" && entry.origin !== "agent")
          throw new Error("Pending queue notifications or delegations need a handoff disposition");
        const captured = await this.readHandoffPrompt(
          agentId,
          entry,
          HANDOFF_QUEUE_MAX_BYTES - bytes,
        );
        bytes += captured.bytes;
        entries.push({
          id: entry.id,
          origin: entry.origin,
          senderAgentId: entry.senderAgentId,
          createdAt: entry.createdAt,
          prompt: captured.prompt,
        });
      }
      if ((options.requireHeld ?? true) && entries.length && !stored?.held)
        throw new Error("Source queue must be held before handoff capture");
      await captureHandoffReviews(entries, options.workspaceCwd);
      const files = await this.captureHandoffUploads(entries, options.blobsDirectory);
      return parseHandoffQueue(
        files.length ? { version: 2, entries, files } : { version: 1, entries },
      );
    });
  }

  private async captureHandoffUploads(
    entries: HandoffQueue["entries"],
    directory?: string,
  ): Promise<CapturedUpload[]> {
    const attachments = queuedUploads(entries);
    if (!attachments.length) return [];
    if (!this.options.uploads)
      throw new Error(
        "Queued attachments with source-local files or paths need a handoff disposition",
      );
    const files = new Map<string, CapturedUpload>();
    let bytes = Buffer.byteLength(JSON.stringify(entries));
    for (const attachment of attachments) {
      const existing = files.get(attachment.path);
      if (existing) {
        if (!isDeepStrictEqual(existing.attachment, attachment))
          throw new Error("Queued upload references conflict");
        continue;
      }
      const captured = await this.options.uploads.captureForHandoff(attachment, {
        directory,
        maxBytes: HANDOFF_QUEUE_MAX_BYTES - bytes,
      });
      bytes += captured.blob.size;
      files.set(attachment.path, captured);
    }
    return [...files.values()];
  }

  private async readHandoffPrompt(agentId: string, entry: AgentQueueEntry, budget: number) {
    if (!entry.promptFile || !/^(?:[a-f0-9-]{36}|[a-f0-9]{64})\.json$/.test(entry.promptFile))
      throw new Error("Queued prompt has an invalid storage reference");
    if (this.directory) {
      const content = await readBoundedFile(
        this.promptPath(this.directory, agentId, entry.promptFile),
        budget,
      );
      return {
        prompt: PromptSchema.parse(JSON.parse(content.toString("utf8"))),
        bytes: content.length,
      };
    }
    const prompt = this.memoryPrompts.get(promptKey(agentId, entry.promptFile));
    if (prompt === undefined) throw new Error("Queued prompt is missing");
    const bytes = Buffer.byteLength(JSON.stringify(prompt));
    if (bytes > budget) throw new Error("Queued messages exceed the handoff byte limit");
    return { prompt, bytes };
  }

  /** The destination journal hides this queue until its exact, held publication is durable. */
  async installHandoffQueue(
    agentId: string,
    reservationId: string,
    input: HandoffQueue,
    options: {
      blobsDirectory?: string;
      workspace?: { sourceCwd: string; destinationCwd: string };
    } = {},
  ): Promise<void> {
    const snapshot = parseHandoffQueue(input);
    if (queueReviews(snapshot.entries).length) {
      if (!options.workspace)
        throw new Error("Queued review requires a destination workspace mapping");
      assertHandoffQueueWorkspace(snapshot, options.workspace.sourceCwd);
      if (!path.isAbsolute(options.workspace.destinationCwd))
        throw new Error("Queued review requires an absolute destination workspace");
    }
    if (!/^[a-zA-Z0-9_-]{1,512}$/.test(agentId))
      throw new Error("Invalid destination queue identity");
    const digest = queueDigest(snapshot);
    await this.serialize(agentId, async () => {
      const existing = this.directory
        ? await this.readHandoffFile(agentId)
        : this.cache.get(agentId);
      if (existing && !isDeepStrictEqual(existing.handoff, { reservationId, digest }))
        throw new Error("Destination queue belongs to a different handoff");
      const uploads = await this.installHandoffUploads(
        snapshot,
        reservationId,
        options.blobsDirectory,
      );
      const prompts = new Map<string, AgentPromptInput>();
      const entries = snapshot.entries.map((entry, index): AgentQueueEntry => {
        const id = `handoff:${queueDigest([agentId, entry.id])}`;
        const remapped = remapHandoffQueueEntry(entry, entry.senderAgentId, id);
        const prompt =
          typeof remapped.prompt === "string"
            ? remapped.prompt
            : remapped.prompt.map((block) => {
                if (block.type === "uploaded_file") return uploads.get(block.path)!;
                if (block.type === "review") block.cwd = options.workspace!.destinationCwd;
                return block;
              });
        const promptFile = `${queueDigest([id, prompt])}.json`;
        prompts.set(promptFile, prompt);
        const preview = previewPrompt(prompt);
        return {
          textPreview: preview.textPreview,
          attachmentCount: preview.attachmentCount,
          id,
          origin: entry.origin,
          senderAgentId: entry.senderAgentId,
          position: index + 1,
          createdAt: entry.createdAt,
          promptFile,
          wake: null,
        };
      });
      const candidate: AgentQueueFile = {
        version: 1,
        agentId,
        held: true,
        heldReason: "user_stop",
        entries,
        handoff: { reservationId, digest },
      };
      if (existing) {
        if (!isDeepStrictEqual({ ...existing, heldReason: candidate.heldReason }, candidate))
          throw new Error("Destination queue changed during handoff installation");
      }
      if (!entries.length) return;
      for (const [name, prompt] of prompts) {
        if (this.directory) {
          const filePath = this.promptPath(this.directory, agentId, name);
          if (existing) {
            const restored = JSON.parse(
              (await readBoundedFile(filePath, HANDOFF_QUEUE_MAX_BYTES)).toString("utf8"),
            );
            if (!isDeepStrictEqual(restored, prompt))
              throw new Error("Destination queued prompt changed");
          } else await writeJsonFileAtomic(filePath, prompt);
          await (this.options.sync ?? syncFilePublication)(filePath, path.dirname(this.directory));
        } else this.memoryPrompts.set(promptKey(agentId, name), prompt);
      }
      if (this.directory) {
        const filePath = this.filePath(this.directory, agentId);
        await writeJsonFileAtomic(filePath, candidate);
        await (this.options.sync ?? syncFilePublication)(filePath, path.dirname(this.directory));
      }
      this.cache.set(agentId, candidate);
    });
  }

  private async installHandoffUploads(
    snapshot: HandoffQueue,
    reservationId: string,
    directory?: string,
  ): Promise<Map<string, UploadedFileAttachment>> {
    const files = snapshot.files ?? [];
    const installed = new Map<string, UploadedFileAttachment>();
    if (!files.length) return installed;
    if (!this.options.uploads || !directory)
      throw new Error("Verified queued upload files are unavailable");
    for (const file of files)
      installed.set(
        file.attachment.path,
        await this.options.uploads.installForHandoff(
          file,
          path.join(directory, file.blob.sha256),
          reservationId,
        ),
      );
    return installed;
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
    const isEmpty = file.entries.length === 0;
    if (this.directory) {
      const filePath = this.filePath(this.directory, agentId);
      if (isEmpty) {
        await rm(filePath, { force: true });
      } else {
        await writeJsonFileAtomic(filePath, file);
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

  private async readHandoffFile(agentId: string): Promise<AgentQueueFile | null> {
    if (!this.directory) return this.cache.get(agentId) ?? null;
    try {
      const content = await readBoundedFile(this.filePath(this.directory, agentId), 1024 * 1024);
      return QueueFileSchema.parse(JSON.parse(content.toString("utf8")));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
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
    const referenced = new Set(file?.entries.flatMap((entry) => entry.promptFile ?? []) ?? []);
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

function queueDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
