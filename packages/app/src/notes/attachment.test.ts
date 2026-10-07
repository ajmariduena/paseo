import { describe, expect, it } from "vitest";
import { noteIdFromAttachment, type Note } from "@getpaseo/protocol/notes/types";
import { UserComposerAttachmentSchema } from "@/stores/draft-store/state";
import {
  createNoteAttachment,
  noteAttachmentToAgentAttachment,
  toggleNoteAttachment,
} from "./attachment";

const note: Note = {
  id: "abc123",
  title: "",
  body: "# Sidebar flickers\n\nOnly on desktop.",
  todoState: "open",
  projectId: null,
  workspaceId: null,
  author: { type: "user" },
  linkedAgents: [],
  archivedAt: null,
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
  revision: 3,
};

describe("note composer attachments", () => {
  it("snapshots the note with a derived title and survives draft persistence", () => {
    const attachment = createNoteAttachment("host-a", note);
    expect(attachment).toMatchObject({
      kind: "note",
      serverId: "host-a",
      noteId: "abc123",
      title: "Sidebar flickers",
      isTodo: true,
    });
    expect(attachment.text).toContain("Todo: Sidebar flickers");
    expect(UserComposerAttachmentSchema.safeParse(attachment).success).toBe(true);
  });

  it("sends a text attachment the daemon can link back to the note", () => {
    const agentAttachment = noteAttachmentToAgentAttachment(createNoteAttachment("host-a", note));
    expect(agentAttachment.type).toBe("text");
    expect(noteIdFromAttachment(agentAttachment)).toBe("abc123");
  });

  it("toggles the same note on and off", () => {
    const attachment = createNoteAttachment("host-a", note);
    const added = toggleNoteAttachment([], attachment);
    expect(added).toEqual([attachment]);
    expect(toggleNoteAttachment(added, attachment)).toEqual([]);
  });
});
