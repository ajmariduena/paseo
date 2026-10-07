import { describe, expect, test } from "vitest";
import type { Note } from "@getpaseo/protocol/notes/types";
import { filterNotes, formatNoteDetail, resolveBodyInput, toNoteCommandError } from "./shared.js";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "abc123",
    title: "Title",
    body: "",
    todoState: null,
    projectId: null,
    workspaceId: null,
    author: { type: "user" },
    linkedAgents: [],
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    ...overrides,
  };
}

const plain = makeNote({ id: "plain" });
const open = makeNote({ id: "open", todoState: "open", projectId: "p1" });
const done = makeNote({ id: "done", todoState: "done" });
const notes = [plain, open, done];

function ids(list: Note[]): string[] {
  return list.map((note) => note.id);
}

describe("filterNotes", () => {
  test("no flags keeps every note", () => {
    expect(ids(filterNotes(notes, {}))).toEqual(["plain", "open", "done"]);
  });

  test("--todos keeps open todos, --done keeps done todos, both keep all todos", () => {
    expect(ids(filterNotes(notes, { todos: true }))).toEqual(["open"]);
    expect(ids(filterNotes(notes, { done: true }))).toEqual(["done"]);
    expect(ids(filterNotes(notes, { todos: true, done: true }))).toEqual(["open", "done"]);
  });

  test("--project keeps only notes attached to that project", () => {
    expect(ids(filterNotes(notes, { project: "p1" }))).toEqual(["open"]);
  });
});

describe("resolveBodyInput", () => {
  const readers = {
    readFile: async (path: string) => `file:${path}`,
    readStdin: async () => "stdin body",
  };

  test("returns --body, a file, or stdin for -", async () => {
    expect(await resolveBodyInput({ body: "inline" }, readers)).toBe("inline");
    expect(await resolveBodyInput({ bodyFile: "notes.md" }, readers)).toBe("file:notes.md");
    expect(await resolveBodyInput({ bodyFile: "-" }, readers)).toBe("stdin body");
    expect(await resolveBodyInput({}, readers)).toBeUndefined();
  });

  test("rejects --body together with --body-file", async () => {
    await expect(resolveBodyInput({ body: "x", bodyFile: "y" }, readers)).rejects.toMatchObject({
      code: "CONFLICTING_BODY_INPUT",
    });
  });

  test("reports an unreadable file", async () => {
    await expect(
      resolveBodyInput(
        { bodyFile: "missing.md" },
        {
          ...readers,
          readFile: async () => {
            throw new Error("ENOENT");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "BODY_FILE_READ_ERROR", details: "ENOENT" });
  });
});

describe("toNoteCommandError", () => {
  test("maps a daemon note error code and strips the rpc suffix", () => {
    const rpcError = Object.assign(
      new Error("Note not found: abc requestType=note.update.request code=note_not_found"),
      { code: "note_not_found" },
    );
    expect(toNoteCommandError("NOTE_UPDATE_FAILED", "update note", rpcError)).toEqual({
      code: "NOTE_NOT_FOUND",
      message: "Note not found: abc",
    });
  });

  test("passes command errors through and wraps anything else", () => {
    const commandError = { code: "DAEMON_UPDATE_REQUIRED", message: "Update the host." };
    expect(toNoteCommandError("X", "list notes", commandError)).toBe(commandError);
    expect(toNoteCommandError("NOTE_LIST_FAILED", "list notes", new Error("boom"))).toEqual({
      code: "NOTE_LIST_FAILED",
      message: "Failed to list notes: boom",
    });
  });
});

describe("formatNoteDetail", () => {
  test("prints the title, metadata, and body", () => {
    const detail = formatNoteDetail(
      makeNote({
        title: "Fix retry",
        body: "Details here",
        todoState: "open",
        projectId: "p1",
        author: { type: "agent", agentId: "agent-1" },
        linkedAgents: [{ agentId: "agent-2", linkedAt: "2026-01-01T00:00:00.000Z" }],
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    expect(detail.split("\n")[0]).toBe("Fix retry");
    expect(detail).toContain("State:         open (archived)");
    expect(detail).toContain("Project:       p1");
    expect(detail).toContain("Author:        agent agent-1");
    expect(detail).toContain("Linked agents: agent-2");
    expect(detail.endsWith("\n\nDetails here")).toBe(true);
  });
});
