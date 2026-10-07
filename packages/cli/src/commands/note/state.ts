import type { Command } from "commander";
import type { Note, NoteTodoState } from "@getpaseo/protocol/notes/types";
import type { SingleResult } from "../../output/index.js";
import {
  noteSchema,
  toNoteCommandError,
  withNoteClient,
  type NoteCommandOptions,
} from "./shared.js";

async function setTodoState(
  id: string,
  todoState: NoteTodoState,
  options: NoteCommandOptions,
): Promise<SingleResult<Note>> {
  try {
    const { note } = await withNoteClient(options.daemonTarget, (client) =>
      client.updateNote({ noteId: id, todoState }),
    );
    return { type: "single", data: note, schema: noteSchema };
  } catch (error) {
    throw toNoteCommandError("NOTE_UPDATE_FAILED", "update note", error);
  }
}

async function setArchived(
  id: string,
  archived: boolean,
  options: NoteCommandOptions,
): Promise<SingleResult<Note>> {
  try {
    const { note } = await withNoteClient(options.daemonTarget, (client) =>
      client.archiveNote({ noteId: id, archived }),
    );
    return { type: "single", data: note, schema: noteSchema };
  } catch (error) {
    throw toNoteCommandError(
      "NOTE_ARCHIVE_FAILED",
      archived ? "archive note" : "restore note",
      error,
    );
  }
}

export function runDoneCommand(id: string, options: NoteCommandOptions, _command: Command) {
  return setTodoState(id, "done", options);
}

export function runReopenCommand(id: string, options: NoteCommandOptions, _command: Command) {
  return setTodoState(id, "open", options);
}

export function runArchiveCommand(id: string, options: NoteCommandOptions, _command: Command) {
  return setArchived(id, true, options);
}

export function runRestoreCommand(id: string, options: NoteCommandOptions, _command: Command) {
  return setArchived(id, false, options);
}
