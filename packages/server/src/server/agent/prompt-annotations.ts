import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MessageOriginSchema, NotificationSourceSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { readBoundedFile } from "../handoff/artifacts.js";

const MAX_ENTRIES_PER_AGENT = 500;

const NotificationAnnotationSchema = z.object({
  kind: z.literal("notification"),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
  source: NotificationSourceSchema.optional(),
});

const OriginAnnotationSchema = z.object({
  kind: z.literal("origin"),
  origin: MessageOriginSchema,
});

const PromptAnnotationSchema = z.discriminatedUnion("kind", [
  NotificationAnnotationSchema,
  OriginAnnotationSchema,
]);

const EntrySchema = z.object({
  messageId: z.string(),
  textHash: z.string(),
  annotation: PromptAnnotationSchema,
});

const FileSchema = z.object({
  version: z.literal(1),
  entries: z.array(EntrySchema),
});
const HandoffFileSchema = FileSchema.extend({
  entries: z
    .array(
      EntrySchema.extend({
        messageId: z.string().min(1),
        textHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(MAX_ENTRIES_PER_AGENT),
});

/** How a prompt the daemon sent appears in the timeline: as a notification, or with its sender. */
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
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string | null) {}

  remember(agentId: string, prompt: AnnotatedPrompt): Promise<void> {
    return this.serialize(agentId, async () => {
      const entries = await this.load(agentId);
      if (!entries)
        throw new Error("Prompt annotation history is invalid; repair it before sending a prompt");
      if (entries.some((entry) => entry.messageId === prompt.messageId)) return;
      const next = [
        ...entries,
        {
          messageId: prompt.messageId,
          textHash: hashText(prompt.text),
          annotation: structuredClone(prompt.annotation),
        },
      ].slice(-MAX_ENTRIES_PER_AGENT);
      if (this.dir)
        await writeJsonFileAtomic(this.filePath(this.dir, agentId), { version: 1, entries: next });
      // A duplicate may acknowledge only an entry whose write actually succeeded.
      this.cache.set(agentId, next);
    });
  }

  /** Only sees prompts remembered or loaded in this process; call after `remember`. */
  forMessage(agentId: string, messageId: string): PromptAnnotation | null {
    const entry = this.cache.get(agentId)?.find((candidate) => candidate.messageId === messageId);
    return entry?.annotation ?? null;
  }

  historyMatcher(agentId: string): Promise<HistoryAnnotationMatcher> {
    return this.serialize(agentId, async () =>
      createHistoryMatcher((await this.load(agentId)) ?? []),
    );
  }

  historyMatcherForHandoff(agentId: string): Promise<HistoryAnnotationMatcher> {
    return this.serialize(agentId, async () => {
      if (!this.dir) return createHistoryMatcher(this.cache.get(agentId) ?? []);
      const entries = await this.readHandoffEntries(agentId);
      const cached = this.cache.get(agentId);
      if (cached && !isDeepStrictEqual(cached, entries))
        throw new Error("Prompt annotation history changed on disk; restore it before handoff");
      return createHistoryMatcher(entries);
    });
  }

  delete(agentId: string): Promise<void> {
    return this.serialize(agentId, async () => {
      if (this.dir) await rm(this.filePath(this.dir, agentId), { force: true });
      this.cache.delete(agentId);
    });
  }

  private async load(agentId: string): Promise<Entry[] | null> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;
    const entries = await this.read(agentId);
    // A permissive history read must not certify corrupt data as an empty committed file.
    if (entries) this.cache.set(agentId, entries);
    return entries;
  }

  private async read(agentId: string): Promise<Entry[] | null> {
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
    return parsed.success ? parsed.data.entries : null;
  }

  private async readHandoffEntries(agentId: string): Promise<Entry[]> {
    if (!this.dir) throw new Error("Prompt annotation directory is unavailable");
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(this.filePath(this.dir, agentId), 16 * 1024 * 1024);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    try {
      const { entries } = HandoffFileSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (new Set(entries.map((entry) => entry.messageId)).size !== entries.length)
        throw new Error("Duplicate prompt annotation");
      return entries;
    } catch {
      throw new Error("Prompt annotation history is invalid; repair it before handoff");
    }
  }

  private serialize<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.tails.set(agentId, next);
    const clear = () => {
      if (this.tails.get(agentId) === next) this.tails.delete(agentId);
    };
    void next.then(clear, clear);
    return next;
  }

  private filePath(dir: string, agentId: string): string {
    return path.join(dir, `${agentId}.json`);
  }
}

function createHistoryMatcher(entries: Entry[]): HistoryAnnotationMatcher {
  const pending = structuredClone(entries);
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

function hashText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}
