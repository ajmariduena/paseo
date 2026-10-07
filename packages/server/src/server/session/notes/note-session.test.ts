import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoteSession } from "./note-session.js";
import { NoteStore } from "../../notes/store.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";

describe("NoteSession", () => {
  let tempDir: string;
  let emitted: SessionOutboundMessage[];
  let session: NoteSession;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "note-session-test-"));
    emitted = [];
    const logger = pino({ level: "silent" });
    session = new NoteSession({
      host: { emit: (message) => emitted.push(message) },
      noteStore: new NoteStore(tempDir, logger),
      logger,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ignores messages that are not note requests", () => {
    expect(session.dispatch({ type: "ping", requestId: "p1" })).toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it("creates a note as the user and lists it back", async () => {
    await session.dispatch({
      type: "note.create.request",
      requestId: "c1",
      title: "Check the retry path",
      todo: true,
      projectId: "project-1",
    });
    const created = findByType(emitted, "note.create.response");
    expect(created?.payload).toMatchObject({
      requestId: "c1",
      note: {
        title: "Check the retry path",
        todoState: "open",
        projectId: "project-1",
        author: { type: "user" },
      },
    });

    await session.dispatch({ type: "note.list.request", requestId: "l1" });
    const listed = findByType(emitted, "note.list.response");
    expect(listed?.payload.requestId).toBe("l1");
    expect(listed?.payload.notes).toEqual([created?.payload.note]);
  });

  it("reports an unknown note id as rpc_error with note_not_found", async () => {
    await session.dispatch({
      type: "note.update.request",
      requestId: "u1",
      noteId: "missing",
      title: "x",
    });

    expect(findByType(emitted, "rpc_error")?.payload).toMatchObject({
      requestId: "u1",
      requestType: "note.update.request",
      code: "note_not_found",
    });
  });
});
