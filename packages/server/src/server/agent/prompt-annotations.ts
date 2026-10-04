import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { NotificationSourceSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

const MAX_ENTRIES_PER_AGENT = 500;

const NotificationAnnotationSchema = z.object({
  kind: z.literal("notification"),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
  source: NotificationSourceSchema.optional(),
});

const PromptAnnotationSchema = z.discriminatedUnion("kind", [NotificationAnnotationSchema]);

const EntrySchema = z.object({
  messageId: z.string(),
  textHash: z.string(),
  annotation: PromptAnnotationSchema,
});

const FileSchema = z.object({
  version: z.literal(1),
  entries: z.array(EntrySchema),
});

/** How a prompt the daemon sent appears in the timeline instead of a plain user message. */
export type PromptAnnotation = z.infer<typeof PromptAnnotationSchema>;
export type NotificationAnnotation = z.infer<typeof NotificationAnnotationSchema>;
type Entry = z.infer<typeof EntrySchema>;

export interface AnnotatedPrompt {
  messageId: string;
  text: string;
  annotation: PromptAnnotation;
}

export interface MatchedAnnotation {
  messageId: string;
  annotation: PromptAnnotation;
}

/**
 * Replayed provider history carries the prompt text but not the daemon's message id, so a
 * replayed message matches by text. Each entry is used once, in send order, so a repeated text
 * maps to repeated entries.
 */
export interface HistoryAnnotationMatcher {
  take(text: string): MatchedAnnotation | null;
}

/**
 * Per-agent record of prompts the daemon sent on someone else's behalf, so the timeline can show
 * them as what they were after the in-memory timeline is rebuilt from provider history.
 * A null directory keeps everything in memory.
 */
export class PromptAnnotationStore {
  private readonly cache = new Map<string, Entry[]>();
  private readonly loads = new Map<string, Promise<Entry[]>>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly dir: string | null) {}

  async remember(agentId: string, prompt: AnnotatedPrompt): Promise<void> {
    const entries = await this.load(agentId);
    if (entries.some((entry) => entry.messageId === prompt.messageId)) {
      return;
    }
    entries.push({
      messageId: prompt.messageId,
      textHash: hashText(prompt.text),
      annotation: prompt.annotation,
    });
    entries.splice(0, Math.max(0, entries.length - MAX_ENTRIES_PER_AGENT));
    await this.persist(agentId, entries);
  }

  /** Only sees prompts remembered or loaded in this process; call after `remember`. */
  forMessage(agentId: string, messageId: string): PromptAnnotation | null {
    const entry = this.cache.get(agentId)?.find((candidate) => candidate.messageId === messageId);
    return entry?.annotation ?? null;
  }

  async historyMatcher(agentId: string): Promise<HistoryAnnotationMatcher> {
    const pending = [...(await this.load(agentId))];
    return {
      take(text: string): MatchedAnnotation | null {
        const textHash = hashText(text);
        const index = pending.findIndex((entry) => entry.textHash === textHash);
        if (index < 0) return null;
        const [entry] = pending.splice(index, 1);
        return entry ? { messageId: entry.messageId, annotation: entry.annotation } : null;
      },
    };
  }

  async delete(agentId: string): Promise<void> {
    this.cache.delete(agentId);
    this.loads.delete(agentId);
    await this.writes.get(agentId);
    if (this.dir) {
      await rm(this.filePath(this.dir, agentId), { force: true });
    }
  }

  private async load(agentId: string): Promise<Entry[]> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;
    const pending = this.loads.get(agentId) ?? this.read(agentId);
    this.loads.set(agentId, pending);
    const entries = await pending;
    if (!this.cache.has(agentId)) this.cache.set(agentId, entries);
    return this.cache.get(agentId) ?? entries;
  }

  private async read(agentId: string): Promise<Entry[]> {
    if (!this.dir) return [];
    let raw: string;
    try {
      raw = await readFile(this.filePath(this.dir, agentId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    // Annotations only decorate the timeline; an unreadable file must not block loading the agent.
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.entries : [];
  }

  private async persist(agentId: string, entries: Entry[]): Promise<void> {
    const dir = this.dir;
    if (!dir) return;
    const snapshot = { version: 1, entries: [...entries] };
    const previous = this.writes.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => writeJsonFileAtomic(this.filePath(dir, agentId), snapshot));
    this.writes.set(agentId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(agentId) === next) this.writes.delete(agentId);
    }
  }

  private filePath(dir: string, agentId: string): string {
    return path.join(dir, `${agentId}.json`);
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}
