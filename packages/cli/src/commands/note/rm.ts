import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { noteDisplayTitle } from "@getpaseo/protocol/notes/types";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";
import { findNote, toNoteCommandError, withNoteClient, type NoteCommandOptions } from "./shared.js";

export interface NoteRmOptions extends NoteCommandOptions {
  yes?: boolean;
}

interface NoteDeleteRow {
  id: string;
  status: "deleted" | "kept";
}

const noteDeleteSchema: OutputSchema<NoteDeleteRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 14 },
    { header: "STATUS", field: "status", width: 10 },
  ],
};

async function confirmOnTerminal(message: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await prompt.question(message)).trim());
  } catch {
    return false;
  } finally {
    prompt.close();
  }
}

function isStructuredOutput(options: NoteRmOptions): boolean {
  return (
    options.json === true || ["json", "yaml"].includes(options.format?.trim().toLowerCase() ?? "")
  );
}

export async function runRmCommand(
  id: string,
  options: NoteRmOptions,
  _command: Command,
): Promise<SingleResult<NoteDeleteRow>> {
  try {
    const status = await withNoteClient(options.daemonTarget, async (client) => {
      if (!options.yes) {
        if (isStructuredOutput(options) || process.stdin.isTTY !== true) {
          throw {
            code: "CONFIRMATION_REQUIRED",
            message: "Deleting a note is permanent; rerun with --yes.",
            details: "Use `paseo note archive` to hide it instead.",
          } satisfies CommandError;
        }
        const note = await findNote(client, id);
        const title = noteDisplayTitle(note) || note.id;
        if (!(await confirmOnTerminal(`Delete "${title}" permanently? [y/N] `))) return "kept";
      }
      await client.deleteNote({ noteId: id });
      return "deleted";
    });
    return { type: "single", data: { id, status }, schema: noteDeleteSchema };
  } catch (error) {
    throw toNoteCommandError("NOTE_DELETE_FAILED", "delete note", error);
  }
}
