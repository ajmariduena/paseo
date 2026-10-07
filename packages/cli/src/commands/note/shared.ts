import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { noteDisplayTitle, type Note } from "@getpaseo/protocol/notes/types";
import type { CommandError, CommandOptions, OutputSchema } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

export interface NoteCommandOptions extends CommandOptions {
  host?: string;
}

export async function withNoteClient<T>(
  target: DaemonTarget,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectNoteClient(target);
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function connectNoteClient(target: DaemonTarget): Promise<DaemonClient> {
  let client: DaemonClient;
  try {
    client = await connectToDaemon({ target });
  } catch (error) {
    if (isCommandError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${getDaemonHost({ target })}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
  // COMPAT(notes): added in v0.11.0, remove gate after 2027-10-07.
  if (client.getLastServerInfoMessage()?.features?.notes !== true) {
    await client.close().catch(() => undefined);
    throw {
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use notes.",
    } satisfies CommandError;
  }
  return client;
}

function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    !(error instanceof Error) &&
    typeof (error as CommandError).code === "string" &&
    typeof (error as CommandError).message === "string"
  );
}

export function toNoteCommandError(code: string, action: string, error: unknown): CommandError {
  if (isCommandError(error)) return error;
  if (error instanceof Error) {
    const rpcCode = (error as Error & { code?: unknown }).code;
    if (typeof rpcCode === "string" && rpcCode.startsWith("note_")) {
      // DaemonRpcError appends " requestType=... code=..." to the daemon's message.
      const message = error.message.replace(/ requestType=\S+(?: code=\S+)?$/, "");
      return { code: rpcCode.toUpperCase(), message };
    }
    return { code, message: `Failed to ${action}: ${error.message}` };
  }
  return { code, message: `Failed to ${action}: ${String(error)}` };
}

export async function findNote(client: DaemonClient, id: string): Promise<Note> {
  const { notes } = await client.listNotes({ includeArchived: true });
  const note = notes.find((candidate) => candidate.id === id);
  if (!note) {
    throw { code: "NOTE_NOT_FOUND", message: `Note not found: ${id}` } satisfies CommandError;
  }
  return note;
}

export interface NoteListFilter {
  todos?: boolean;
  done?: boolean;
  project?: string;
}

export function filterNotes(notes: Note[], filter: NoteListFilter): Note[] {
  const states = new Set<Note["todoState"]>();
  if (filter.todos) states.add("open");
  if (filter.done) states.add("done");
  return notes.filter(
    (note) =>
      (states.size === 0 || states.has(note.todoState)) &&
      (filter.project === undefined || note.projectId === filter.project),
  );
}

export interface BodyInputSources {
  body?: string;
  bodyFile?: string;
}

export interface BodyReaders {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
}

const defaultBodyReaders: BodyReaders = {
  readFile: (path) => readFile(resolve(path), "utf8"),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
};

export async function resolveBodyInput(
  sources: BodyInputSources,
  readers: BodyReaders = defaultBodyReaders,
): Promise<string | undefined> {
  if (sources.body !== undefined && sources.bodyFile !== undefined) {
    throw {
      code: "CONFLICTING_BODY_INPUT",
      message: "Use either --body or --body-file, not both",
    } satisfies CommandError;
  }
  if (sources.bodyFile === undefined) return sources.body;
  const path = sources.bodyFile.trim();
  if (!path) {
    throw {
      code: "INVALID_BODY_FILE",
      message: "--body-file cannot be empty",
    } satisfies CommandError;
  }
  try {
    return path === "-" ? await readers.readStdin() : await readers.readFile(path);
  } catch (error) {
    throw {
      code: "BODY_FILE_READ_ERROR",
      message: `Failed to read body file: ${path}`,
      details: error instanceof Error ? error.message : String(error),
    } satisfies CommandError;
  }
}

export function formatNoteState(note: Note): string {
  const state = note.todoState ?? "note";
  return note.archivedAt ? `${state} (archived)` : state;
}

export function formatNoteAuthor(note: Note): string {
  return note.author.type === "agent" ? `agent ${note.author.agentId}` : "user";
}

export const noteSchema: OutputSchema<Note> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 14 },
    { header: "STATE", field: formatNoteState, width: 16 },
    { header: "TITLE", field: (note) => noteDisplayTitle(note), width: 48 },
    { header: "PROJECT", field: "projectId", width: 20 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
  ],
};

export function formatNoteDetail(note: Note): string {
  const linkedAgents = note.linkedAgents.map((link) => link.agentId).join(", ");
  const lines = [
    noteDisplayTitle(note) || "(untitled)",
    "",
    `ID:            ${note.id}`,
    `State:         ${formatNoteState(note)}`,
    `Project:       ${note.projectId ?? "-"}`,
    `Author:        ${formatNoteAuthor(note)}`,
    `Linked agents: ${linkedAgents || "-"}`,
    `Updated:       ${note.updatedAt}`,
  ];
  const body = note.body.trim();
  if (body) lines.push("", body);
  return lines.join("\n");
}

export const noteDetailSchema: OutputSchema<Note> = {
  ...noteSchema,
  renderHuman: (result) =>
    result.type === "single"
      ? formatNoteDetail(result.data)
      : result.data.map(formatNoteDetail).join("\n\n"),
};
