import { createHash, type UUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MessageOriginSchema, NotificationSourceSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

import { syncFilePublication, writeJsonFileAtomic } from "../atomic-file.js";
import { readBoundedFile } from "../handoff/artifacts.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_ATTEMPTS = 32;

const NativeDispatchSchema = z.object({
  messageId: z.string().uuid(),
  state: z.enum(["prepared", "dispatched", "withdrawn"]),
});

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
  nativeDispatches: z.array(NativeDispatchSchema).max(MAX_NATIVE_ATTEMPTS).optional(),
});

const FileSchema = z.object({
  version: z.literal(1),
  entries: z.array(EntrySchema),
});
const HandoffFileSchema = FileSchema.extend({
  entries: z.array(
    EntrySchema.extend({
      messageId: z.string().min(1),
      textHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});

/** How a prompt the daemon sent appears in the timeline: as a notification, or with its sender. */
export type PromptAnnotation = z.infer<typeof PromptAnnotationSchema>;
export type NotificationAnnotation = z.infer<typeof NotificationAnnotationSchema>;
type Entry = z.infer<typeof EntrySchema>;
interface NativeHistoryEntry {
  entry: Entry;
  dispatch: z.infer<typeof NativeDispatchSchema>;
}

export interface AnnotatedPrompt {
  messageId: string;
  text: string;
  annotation: PromptAnnotation;
  nativeMessageIds?: boolean;
}

export interface NativePromptDispatch {
  agentId: string;
  messageId: string;
  nativeMessageId: UUID;
}

export interface SettledNativePromptDispatch extends NativePromptDispatch {
  state: "dispatched" | "withdrawn";
}

export interface MatchedAnnotation {
  messageId: string;
  annotation: PromptAnnotation;
}

/**
 * Native identities distinguish identical prompts and survive prepended context. Older
 * records and adapters without that contract retain text matching with unproven identity.
 */
export interface HistoryAnnotationMatcher {
  take(text: string, nativeMessageId?: string): MatchedAnnotation | null;
  assertNativeDispatchesResolved(): void;
}

/**
 * Per-agent record of prompts the daemon sent on someone else's behalf, so the timeline can show
 * them as what they were after the in-memory timeline is rebuilt from provider history.
 * A null directory keeps everything in memory.
 */
export class PromptAnnotationStore {
  private readonly cache = new Map<string, Entry[]>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, Entry[]>();

  constructor(
    private readonly dir: string | null,
    private readonly synchronize: typeof syncFilePublication = syncFilePublication,
  ) {}

  remember(agentId: string, prompt: AnnotatedPrompt): Promise<void> {
    const snapshot = structuredClone(prompt);
    return this.serialize(agentId, async () => {
      const entries = await this.load(agentId);
      if (!entries)
        throw new Error("Prompt annotation history is invalid; repair it before sending a prompt");
      if (entries.some((entry) => entry.messageId === snapshot.messageId)) return;
      const next = [
        ...entries,
        {
          messageId: snapshot.messageId,
          textHash: hashText(snapshot.text),
          annotation: snapshot.annotation,
          ...(snapshot.nativeMessageIds ? { nativeDispatches: [] } : {}),
        },
      ];
      await this.save(agentId, next);
    });
  }

  prepareNativeDispatch(input: NativePromptDispatch): Promise<boolean> {
    const { agentId, messageId, nativeMessageId } = input;
    return this.serialize(agentId, async () => {
      const entries = await this.load(agentId);
      if (!entries) throw new Error("Prompt annotation history is invalid");
      const next = structuredClone(entries);
      const entry = next.find((candidate) => candidate.messageId === messageId);
      if (!entry) return false;
      if (!entry.nativeDispatches) {
        throw new Error("Legacy prompt annotation has no native identity; use a new message id");
      }
      const existing = entry.nativeDispatches.find(
        (attempt) => attempt.messageId === nativeMessageId,
      );
      if (existing?.state === "prepared") return true;
      if (
        next.some((candidate) =>
          candidate.nativeDispatches?.some((attempt) => attempt.messageId === nativeMessageId),
        )
      )
        throw new Error("Native prompt identity was already prepared");
      if (entry.nativeDispatches.length >= MAX_NATIVE_ATTEMPTS) {
        throw new Error("Prompt annotation dispatch capacity exceeded");
      }
      entry.nativeDispatches.push(
        NativeDispatchSchema.parse({
          messageId: nativeMessageId,
          state: "prepared",
        }),
      );
      await this.save(agentId, next);
      return true;
    });
  }

  settleNativeDispatch(input: SettledNativePromptDispatch): Promise<void> {
    const { agentId, messageId, nativeMessageId, state } = input;
    return this.serialize(agentId, async () => {
      const entries = await this.load(agentId);
      if (!entries) throw new Error("Prompt annotation history is invalid");
      const next = structuredClone(entries);
      const entry = next.find((candidate) => candidate.messageId === messageId);
      const attempt = entry?.nativeDispatches?.find(
        (candidate) => candidate.messageId === nativeMessageId,
      );
      if (!attempt) throw new Error("Native prompt identity was not prepared");
      if (attempt.state === state) return;
      if (attempt.state !== "prepared") throw new Error("Native prompt disposition cannot change");
      attempt.state = state;
      await this.save(agentId, next);
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
      await this.publishPending(agentId);
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
      this.pending.delete(agentId);
    });
  }

  private async load(agentId: string): Promise<Entry[] | null> {
    await this.publishPending(agentId);
    const cached = this.cache.get(agentId);
    if (cached) return cached;
    const entries = await this.read(agentId);
    // A permissive history read must not certify corrupt data as an empty committed file.
    if (entries) this.cache.set(agentId, entries);
    return entries;
  }

  private async save(agentId: string, entries: Entry[]): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify({ version: 1, entries }, null, 2));
    const pendingAttempts = entries.flatMap((entry) => entry.nativeDispatches ?? []);
    const preparedCount = pendingAttempts.filter((attempt) => attempt.state === "prepared").length;
    const dispositionReserve = preparedCount * ("dispatched".length - "prepared".length);
    if (bytes + dispositionReserve > MAX_FILE_BYTES)
      throw new Error("Prompt annotation storage capacity exceeded");
    this.pending.set(agentId, structuredClone(entries));
    await this.publishPending(agentId);
  }

  private async publishPending(agentId: string): Promise<void> {
    const entries = this.pending.get(agentId);
    if (!entries) return;
    if (this.dir) {
      const file = this.filePath(this.dir, agentId);
      await writeJsonFileAtomic(file, { version: 1, entries });
      if (process.platform !== "win32") await this.synchronize(file, path.dirname(this.dir));
    }
    this.cache.set(agentId, entries);
    this.pending.delete(agentId);
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
    const parsed = HandoffFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !hasUniqueIdentities(parsed.data.entries)) return null;
    return parsed.data.entries;
  }

  private async readHandoffEntries(agentId: string): Promise<Entry[]> {
    if (!this.dir) throw new Error("Prompt annotation directory is unavailable");
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(this.filePath(this.dir, agentId), MAX_FILE_BYTES);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    try {
      const { entries } = HandoffFileSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (!hasUniqueIdentities(entries)) throw new Error("Duplicate prompt identity");
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
  const observed = new Set<string>();
  const nativeEntries = new Map<string, NativeHistoryEntry>();
  const legacyEntries = new Map<string, Entry[]>();
  for (const entry of pending.toReversed()) {
    if (entry.nativeDispatches) {
      for (const dispatch of entry.nativeDispatches)
        nativeEntries.set(dispatch.messageId, { entry, dispatch });
    } else {
      const bucket = legacyEntries.get(entry.textHash) ?? [];
      bucket.push(entry);
      legacyEntries.set(entry.textHash, bucket);
    }
  }
  return {
    take(text: string, nativeMessageId?: string): MatchedAnnotation | null {
      if (nativeMessageId) {
        const native = nativeEntries.get(nativeMessageId);
        if (native) {
          if (native.dispatch.state !== "dispatched" || observed.has(nativeMessageId)) return null;
          observed.add(nativeMessageId);
          return { messageId: native.entry.messageId, annotation: native.entry.annotation };
        }
      }
      const textHash = hashText(text);
      const entry = legacyEntries.get(textHash)?.pop();
      return entry ? { messageId: entry.messageId, annotation: entry.annotation } : null;
    },
    assertNativeDispatchesResolved(): void {
      for (const { dispatch } of nativeEntries.values()) {
        if (dispatch.state === "prepared")
          throw new Error("Native prompt dispatch outcome is unresolved");
        if (dispatch.state === "dispatched" && !observed.has(dispatch.messageId)) {
          throw new Error("Dispatched native prompt is absent from provider history");
        }
      }
    },
  };
}

function hasUniqueIdentities(entries: Entry[]): boolean {
  if (new Set(entries.map((entry) => entry.messageId)).size !== entries.length) return false;
  const nativeIds = entries.flatMap(
    (entry) => entry.nativeDispatches?.map((attempt) => attempt.messageId) ?? [],
  );
  return new Set(nativeIds).size === nativeIds.length;
}

function hashText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}
