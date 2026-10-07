import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  NoteSchema,
  type Note,
  type NoteAuthor,
  type NoteTodoState,
} from "@getpaseo/protocol/notes/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

export type NoteErrorCode = "note_not_found" | "note_invalid" | "note_revision_conflict";

export class NoteError extends Error {
  constructor(
    readonly code: NoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NoteError";
  }
}

export interface CreateNoteInput {
  title: string;
  body?: string;
  todo?: boolean;
  projectId?: string | null;
  workspaceId?: string | null;
  author: NoteAuthor;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  todoState?: NoteTodoState | null;
  projectId?: string | null;
  expectedRevision?: number;
}

export interface ListNotesOptions {
  includeArchived?: boolean;
}

function generateNoteId(): string {
  return randomBytes(6).toString("hex");
}

function parseStoredNote(
  content: string,
): { success: true; data: Note } | { success: false; error: unknown } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { success: false, error };
  }
  return NoteSchema.safeParse(json);
}

function assertHasContent(title: string, body: string): void {
  if (!title.trim() && !body.trim()) {
    throw new NoteError("note_invalid", "A note needs a title or a body");
  }
}

export class NoteStore {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private reportedInvalidFiles = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async list(options: ListNotesOptions = {}): Promise<Note[]> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = join(this.dir, entry.name);
          return { filePath, parsed: parseStoredNote(await readFile(filePath, "utf-8")) };
        }),
    );
    const notes: Note[] = [];
    const invalidFiles = new Set<string>();
    for (const { filePath, parsed } of files) {
      if (parsed.success) {
        if (options.includeArchived || parsed.data.archivedAt === null) notes.push(parsed.data);
        continue;
      }
      invalidFiles.add(filePath);
      if (!this.reportedInvalidFiles.has(filePath)) {
        this.logger.error({ err: parsed.error, filePath }, "Skipping invalid note file");
      }
    }
    this.reportedInvalidFiles = invalidFiles;
    return notes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string): Promise<Note | null> {
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return NoteSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async require(id: string): Promise<Note> {
    const note = await this.get(id);
    if (!note) throw new NoteError("note_not_found", `Note not found: ${id}`);
    return note;
  }

  async create(input: CreateNoteInput): Promise<Note> {
    const body = input.body ?? "";
    assertHasContent(input.title, body);
    const timestamp = this.now().toISOString();
    const note = NoteSchema.parse({
      id: generateNoteId(),
      title: input.title.trim(),
      body,
      todoState: input.todo ? "open" : null,
      projectId: input.projectId ?? null,
      workspaceId: input.workspaceId ?? null,
      author: input.author,
      linkedAgents: [],
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0,
    });
    await this.write(note);
    return note;
  }

  async update(id: string, input: UpdateNoteInput): Promise<Note> {
    return this.mutate(id, (current) => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new NoteError(
          "note_revision_conflict",
          "This note changed somewhere else. Reload it before saving.",
        );
      }
      const next: Note = {
        ...current,
        ...(input.title === undefined ? {} : { title: input.title.trim() }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.todoState === undefined ? {} : { todoState: input.todoState }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      };
      assertHasContent(next.title, next.body);
      return next;
    });
  }

  async setArchived(id: string, archived: boolean): Promise<Note> {
    return this.mutate(id, (current) => {
      if (archived === (current.archivedAt !== null)) return current;
      return { ...current, archivedAt: archived ? this.now().toISOString() : null };
    });
  }

  async linkAgent(id: string, agentId: string): Promise<Note> {
    return this.mutate(id, (current) => {
      if (current.linkedAgents.some((link) => link.agentId === agentId)) return current;
      return {
        ...current,
        linkedAgents: [...current.linkedAgents, { agentId, linkedAt: this.now().toISOString() }],
      };
    });
  }

  async delete(id: string): Promise<void> {
    await this.serialize(id, async () => {
      await this.require(id);
      await rm(this.filePath(id), { force: true });
    });
  }

  private async mutate(id: string, apply: (current: Note) => Note): Promise<Note> {
    return this.serialize(id, async () => {
      const current = await this.require(id);
      const next = apply(current);
      if (next === current) return current;
      const updated = NoteSchema.parse({
        ...next,
        id,
        updatedAt: this.now().toISOString(),
        revision: current.revision + 1,
      });
      await this.write(updated);
      return updated;
    });
  }

  private async write(note: Note): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJsonFileAtomic(this.filePath(note.id), note);
  }

  private async serialize<T>(key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(key) === next) this.mutations.delete(key);
    }
  }
}

export function createNoteStore(paseoHome: string, logger: Logger): NoteStore {
  return new NoteStore(join(paseoHome, "notes"), logger.child({ module: "notes" }));
}
