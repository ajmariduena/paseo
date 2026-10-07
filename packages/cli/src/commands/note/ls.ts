import type { Command } from "commander";
import type { Note } from "@getpaseo/protocol/notes/types";
import type { ListResult } from "../../output/index.js";
import {
  filterNotes,
  noteSchema,
  toNoteCommandError,
  withNoteClient,
  type NoteCommandOptions,
} from "./shared.js";

export interface NoteLsOptions extends NoteCommandOptions {
  todos?: boolean;
  done?: boolean;
  archived?: boolean;
  project?: string;
}

export async function runLsCommand(
  options: NoteLsOptions,
  _command: Command,
): Promise<ListResult<Note>> {
  try {
    const { notes } = await withNoteClient(options.daemonTarget, (client) =>
      client.listNotes({ includeArchived: options.archived === true }),
    );
    return {
      type: "list",
      data: filterNotes(notes, options),
      schema: noteSchema,
    };
  } catch (error) {
    throw toNoteCommandError("NOTE_LIST_FAILED", "list notes", error);
  }
}
