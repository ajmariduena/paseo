import type { Command } from "commander";
import type { Note } from "@getpaseo/protocol/notes/types";
import type { CommandError, SingleResult } from "../../output/index.js";
import {
  noteSchema,
  resolveBodyInput,
  toNoteCommandError,
  withNoteClient,
  type NoteCommandOptions,
} from "./shared.js";

export interface NoteEditOptions extends NoteCommandOptions {
  title?: string;
  body?: string;
  bodyFile?: string;
}

export async function runEditCommand(
  id: string,
  options: NoteEditOptions,
  _command: Command,
): Promise<SingleResult<Note>> {
  try {
    const body = await resolveBodyInput(options);
    if (options.title === undefined && body === undefined) {
      throw {
        code: "NO_UPDATES",
        message: "Specify --title, --body, or --body-file",
      } satisfies CommandError;
    }
    const { note } = await withNoteClient(options.daemonTarget, (client) =>
      client.updateNote({
        noteId: id,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(body === undefined ? {} : { body }),
      }),
    );
    return { type: "single", data: note, schema: noteSchema };
  } catch (error) {
    throw toNoteCommandError("NOTE_UPDATE_FAILED", "update note", error);
  }
}
