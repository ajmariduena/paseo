import type { Command } from "commander";
import type { Note } from "@getpaseo/protocol/notes/types";
import type { SingleResult } from "../../output/index.js";
import {
  findNote,
  noteDetailSchema,
  toNoteCommandError,
  withNoteClient,
  type NoteCommandOptions,
} from "./shared.js";

export async function runShowCommand(
  id: string,
  options: NoteCommandOptions,
  _command: Command,
): Promise<SingleResult<Note>> {
  try {
    const note = await withNoteClient(options.daemonTarget, (client) => findNote(client, id));
    return { type: "single", data: note, schema: noteDetailSchema };
  } catch (error) {
    throw toNoteCommandError("NOTE_SHOW_FAILED", "show note", error);
  }
}
