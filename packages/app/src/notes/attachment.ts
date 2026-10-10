import { z } from "zod";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import {
  formatNoteForPrompt,
  noteDisplayTitle,
  noteResourceUrl,
  NOTE_RESOURCE_PROVIDER,
  NOTE_RESOURCE_TYPE,
  type Note,
} from "@getpaseo/protocol/notes/types";

// The text is captured when the note is attached, so later edits never change a pending prompt.
export const NoteComposerAttachmentSchema = z.strictObject({
  kind: z.literal("note"),
  serverId: z.string().min(1),
  noteId: z.string().min(1),
  title: z.string(),
  isTodo: z.boolean(),
  text: z.string(),
});

export type NoteComposerAttachment = z.infer<typeof NoteComposerAttachmentSchema>;

export function createNoteAttachment(serverId: string, note: Note): NoteComposerAttachment {
  return {
    kind: "note",
    serverId,
    noteId: note.id,
    title: noteDisplayTitle(note),
    isTodo: note.todoState !== null,
    text: formatNoteForPrompt(note),
  };
}

export function noteAttachmentKey(attachment: Pick<NoteComposerAttachment, "noteId">): string {
  return `note:${attachment.noteId}`;
}

export function toggleNoteAttachment<T extends { kind: string }>(
  current: readonly T[],
  attachment: NoteComposerAttachment,
): (T | NoteComposerAttachment)[] {
  const matches = (candidate: T | NoteComposerAttachment) =>
    candidate.kind === "note" && (candidate as NoteComposerAttachment).noteId === attachment.noteId;
  if (current.some(matches)) {
    return current.filter((candidate) => !matches(candidate));
  }
  return [...current, attachment];
}

export function noteAttachmentToAgentAttachment(
  attachment: NoteComposerAttachment,
): AgentAttachment {
  return {
    type: "text",
    mimeType: "text/plain",
    title: attachment.title,
    text: attachment.text,
    externalResource: {
      provider: NOTE_RESOURCE_PROVIDER,
      providerLabel: attachment.isTodo ? "Todo" : "Note",
      resourceType: NOTE_RESOURCE_TYPE,
      id: attachment.noteId,
      identifier: "",
      title: attachment.title,
      url: noteResourceUrl(attachment.noteId),
    },
  };
}
