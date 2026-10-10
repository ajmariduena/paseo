import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runAddCommand } from "./add.js";
import { runEditCommand } from "./edit.js";
import { runLsCommand } from "./ls.js";
import { runRmCommand } from "./rm.js";
import { runShowCommand } from "./show.js";
import { runArchiveCommand, runDoneCommand, runReopenCommand, runRestoreCommand } from "./state.js";

const BODY_FILE_DESCRIPTION = "Read the Markdown body from a UTF-8 file, or - for stdin";

export function createNoteCommand(): Command {
  const note = new Command("note").description("Manage notes and todos");

  addJsonAndDaemonHostOptions(
    note
      .command("ls")
      .description("List notes, most recently updated first")
      .option("--todos", "Only open todos")
      .option("--done", "Only done todos (with --todos: all todos)")
      .option("--archived", "Include archived notes")
      .option("--project <id>", "Only notes attached to this project"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    note
      .command("add")
      .description("Create a note")
      .argument("<title>", "Note title")
      .option("--body <markdown>", "Markdown body")
      .option("--body-file <path>", BODY_FILE_DESCRIPTION)
      .option("--todo", "Create it as an open todo")
      .option("--project <id>", "Attach the note to a project"),
  ).action(withOutput(runAddCommand));

  addJsonAndDaemonHostOptions(
    note.command("show").description("Show a note and its body").argument("<id>", "Note ID"),
  ).action(withOutput(runShowCommand));

  addJsonAndDaemonHostOptions(
    note
      .command("edit")
      .description("Edit a note's title or body")
      .argument("<id>", "Note ID")
      .option("--title <title>", "New title")
      .option("--body <markdown>", "New Markdown body")
      .option("--body-file <path>", BODY_FILE_DESCRIPTION),
  ).action(withOutput(runEditCommand));

  addJsonAndDaemonHostOptions(
    note.command("done").description("Mark a todo done").argument("<id>", "Note ID"),
  ).action(withOutput(runDoneCommand));

  addJsonAndDaemonHostOptions(
    note
      .command("reopen")
      .description("Reopen a todo, or turn a note into an open todo")
      .argument("<id>", "Note ID"),
  ).action(withOutput(runReopenCommand));

  addJsonAndDaemonHostOptions(
    note.command("archive").description("Archive a note").argument("<id>", "Note ID"),
  ).action(withOutput(runArchiveCommand));

  addJsonAndDaemonHostOptions(
    note.command("restore").description("Restore an archived note").argument("<id>", "Note ID"),
  ).action(withOutput(runRestoreCommand));

  addJsonAndDaemonHostOptions(
    note
      .command("rm")
      .description("Delete a note permanently")
      .argument("<id>", "Note ID")
      .option("--yes", "Delete without asking"),
  ).action(withOutput(runRmCommand));

  return note;
}
