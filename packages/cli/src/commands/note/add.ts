import type { Command } from "commander";
import type { Note } from "@getpaseo/protocol/notes/types";
import type { SingleResult } from "../../output/index.js";
import {
  noteSchema,
  resolveBodyInput,
  toNoteCommandError,
  withNoteClient,
  type NoteCommandOptions,
} from "./shared.js";

export interface NoteAddOptions extends NoteCommandOptions {
  body?: string;
  bodyFile?: string;
  todo?: boolean;
  project?: string;
}

export async function runAddCommand(
  title: string,
  options: NoteAddOptions,
  _command: Command,
): Promise<SingleResult<Note>> {
  try {
    const body = await resolveBodyInput(options);
    const { note } = await withNoteClient(options.daemonTarget, (client) =>
      client.createNote({
        title,
        ...(body === undefined ? {} : { body }),
        ...(options.todo ? { todo: true } : {}),
        ...(options.project === undefined ? {} : { projectId: options.project }),
      }),
    );
    return { type: "single", data: note, schema: noteSchema };
  } catch (error) {
    throw toNoteCommandError("NOTE_CREATE_FAILED", "create note", error);
  }
}
