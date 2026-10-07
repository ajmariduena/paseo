import { z } from "zod";

export const NoteTodoStateSchema = z.enum(["open", "done"]);

export const NoteAuthorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({ type: z.literal("agent"), agentId: z.string() }),
]);

export const NoteLinkedAgentSchema = z.object({
  agentId: z.string(),
  linkedAt: z.string(),
});

export const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  // Null means a plain note; open/done makes it a todo.
  todoState: NoteTodoStateSchema.nullable(),
  projectId: z.string().nullable(),
  // Where the note was captured. Context only: archiving the workspace keeps the note.
  workspaceId: z.string().nullable(),
  author: NoteAuthorSchema,
  linkedAgents: z.array(NoteLinkedAgentSchema),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
});

export type NoteTodoState = z.infer<typeof NoteTodoStateSchema>;
export type NoteAuthor = z.infer<typeof NoteAuthorSchema>;
export type NoteLinkedAgent = z.infer<typeof NoteLinkedAgentSchema>;
export type Note = z.infer<typeof NoteSchema>;

export function noteDisplayTitle(note: Pick<Note, "title" | "body">): string {
  const title = note.title.trim();
  if (title) return title;
  const firstLine = note.body
    .split("\n")
    .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
    .find((line) => line.length > 0);
  return firstLine ?? "";
}

export function formatNoteForPrompt(note: Pick<Note, "title" | "body" | "todoState">): string {
  const title = noteDisplayTitle(note);
  const heading = note.todoState ? `Todo: ${title}` : `Note: ${title}`;
  const body = note.body.trim();
  if (!body || body === title) return heading;
  return `${heading}\n\n${body}`;
}

export const NOTE_RESOURCE_PROVIDER = "paseo";
export const NOTE_RESOURCE_TYPE = "note";

interface NoteResourceCarrier {
  type: string;
  externalResource?: { provider: string; resourceType: string; id: string };
}

export function noteResourceUrl(noteId: string): string {
  return `paseo://notes/${noteId}`;
}

// A note handed to an agent travels as a text attachment tagged with this resource, so the
// daemon can link the note back to the agent on whichever path delivers the prompt.
export function noteIdFromAttachment(attachment: NoteResourceCarrier): string | null {
  const resource = attachment.type === "text" ? attachment.externalResource : undefined;
  if (
    resource?.provider !== NOTE_RESOURCE_PROVIDER ||
    resource.resourceType !== NOTE_RESOURCE_TYPE
  ) {
    return null;
  }
  return resource.id;
}
