import { z } from "zod";
import { NoteSchema, NoteTodoStateSchema } from "./types.js";

// Failures are reported through rpc_error with a note_* code, like workspace labels.

export const NoteListRequestSchema = z.object({
  type: z.literal("note.list.request"),
  requestId: z.string(),
  includeArchived: z.boolean().optional(),
});

export const NoteCreateRequestSchema = z.object({
  type: z.literal("note.create.request"),
  requestId: z.string(),
  title: z.string(),
  body: z.string().optional(),
  todo: z.boolean().optional(),
  projectId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
});

export const NoteUpdateRequestSchema = z.object({
  type: z.literal("note.update.request"),
  requestId: z.string(),
  noteId: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  todoState: NoteTodoStateSchema.nullable().optional(),
  projectId: z.string().nullable().optional(),
  // When set, the update is rejected with note_revision_conflict if the note moved on.
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const NoteArchiveRequestSchema = z.object({
  type: z.literal("note.archive.request"),
  requestId: z.string(),
  noteId: z.string(),
  archived: z.boolean(),
});

export const NoteDeleteRequestSchema = z.object({
  type: z.literal("note.delete.request"),
  requestId: z.string(),
  noteId: z.string(),
});

export const NoteLinkAgentRequestSchema = z.object({
  type: z.literal("note.link_agent.request"),
  requestId: z.string(),
  noteId: z.string(),
  agentId: z.string(),
});

export const NoteListResponseSchema = z.object({
  type: z.literal("note.list.response"),
  payload: z.object({
    requestId: z.string(),
    notes: z.array(NoteSchema),
  }),
});

const NoteResultPayloadSchema = z.object({
  requestId: z.string(),
  note: NoteSchema,
});

export const NoteCreateResponseSchema = z.object({
  type: z.literal("note.create.response"),
  payload: NoteResultPayloadSchema,
});

export const NoteUpdateResponseSchema = z.object({
  type: z.literal("note.update.response"),
  payload: NoteResultPayloadSchema,
});

export const NoteArchiveResponseSchema = z.object({
  type: z.literal("note.archive.response"),
  payload: NoteResultPayloadSchema,
});

export const NoteDeleteResponseSchema = z.object({
  type: z.literal("note.delete.response"),
  payload: z.object({
    requestId: z.string(),
    noteId: z.string(),
  }),
});

export const NoteLinkAgentResponseSchema = z.object({
  type: z.literal("note.link_agent.response"),
  payload: NoteResultPayloadSchema,
});

export type NoteListRequest = z.infer<typeof NoteListRequestSchema>;
export type NoteCreateRequest = z.infer<typeof NoteCreateRequestSchema>;
export type NoteUpdateRequest = z.infer<typeof NoteUpdateRequestSchema>;
export type NoteArchiveRequest = z.infer<typeof NoteArchiveRequestSchema>;
export type NoteDeleteRequest = z.infer<typeof NoteDeleteRequestSchema>;
export type NoteLinkAgentRequest = z.infer<typeof NoteLinkAgentRequestSchema>;
export type NoteListResponse = z.infer<typeof NoteListResponseSchema>;
export type NoteCreateResponse = z.infer<typeof NoteCreateResponseSchema>;
export type NoteUpdateResponse = z.infer<typeof NoteUpdateResponseSchema>;
export type NoteArchiveResponse = z.infer<typeof NoteArchiveResponseSchema>;
export type NoteDeleteResponse = z.infer<typeof NoteDeleteResponseSchema>;
export type NoteLinkAgentResponse = z.infer<typeof NoteLinkAgentResponseSchema>;
