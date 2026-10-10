import { z } from "zod";
export const HANDOFF_CHUNK_BYTES = 256 * 1024;
export const HANDOFF_CHUNK_BASE64_CHARS = 349528;
export const HandoffTransferIdSchema = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
export const HandoffDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const HandoffBlobSchema = z.object({
  sha256: HandoffDigestSchema,
  size: z.number().int().nonnegative().safe(),
});
export type HandoffBlob = z.infer<typeof HandoffBlobSchema>;
export const HandoffArchiveManifestSchema = z.object({
  version: z.literal(1),
  entrypoint: HandoffBlobSchema,
  blobs: z.array(HandoffBlobSchema).max(100_010),
});
export type HandoffArchiveManifest = z.infer<typeof HandoffArchiveManifestSchema>;
export const HandoffArchiveStatusSchema = z.object({
  id: HandoffTransferIdSchema,
  state: z.enum(["receiving", "verified"]),
  blobs: z
    .array(HandoffBlobSchema.extend({ receivedBytes: z.number().int().nonnegative().safe() }))
    .max(100_010),
});
export type HandoffArchiveStatus = z.infer<typeof HandoffArchiveStatusSchema>;
export const HandoffErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  blob: HandoffDigestSchema.nullable(),
});
export type HandoffError = z.infer<typeof HandoffErrorSchema>;

export const HandoffArchiveBeginRequestSchema = z.object({
  type: z.literal("workspace.handoff.begin_archive.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  manifest: HandoffArchiveManifestSchema,
});
export const HandoffArchiveBeginResponseSchema = z.object({
  type: z.literal("workspace.handoff.begin_archive.response"),
  payload: z.object({
    requestId: z.string(),
    transferId: HandoffTransferIdSchema,
    result: HandoffArchiveStatusSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffArchiveStatusRequestSchema = z.object({
  type: z.literal("workspace.handoff.get_archive_status.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
});
export const HandoffArchiveStatusResponseSchema = z.object({
  type: z.literal("workspace.handoff.get_archive_status.response"),
  payload: z.object({
    requestId: z.string(),
    transferId: HandoffTransferIdSchema,
    result: HandoffArchiveStatusSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffArchiveWriteChunkRequestSchema = z.object({
  type: z.literal("workspace.handoff.write_archive_chunk.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  sha256: HandoffDigestSchema,
  offset: z.number().int().nonnegative().safe(),
  data: z.string().min(1).max(HANDOFF_CHUNK_BASE64_CHARS),
});
export const HandoffArchiveWriteChunkResponseSchema = z.object({
  type: z.literal("workspace.handoff.write_archive_chunk.response"),
  payload: z.object({
    requestId: z.string(),
    transferId: HandoffTransferIdSchema,
    result: z.number().int().nonnegative().safe().nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffArchiveReadChunkRequestSchema = z.object({
  type: z.literal("workspace.handoff.read_archive_chunk.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  sha256: HandoffDigestSchema,
  offset: z.number().int().nonnegative().safe(),
  length: z.number().int().min(1).max(HANDOFF_CHUNK_BYTES),
});
export const HandoffArchiveReadChunkResponseSchema = z.object({
  type: z.literal("workspace.handoff.read_archive_chunk.response"),
  payload: z.object({
    requestId: z.string(),
    transferId: HandoffTransferIdSchema,
    result: z.string().max(HANDOFF_CHUNK_BASE64_CHARS).nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffArchiveSealRequestSchema = z.object({
  type: z.literal("workspace.handoff.seal_archive.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
});
export const HandoffArchiveSealResponseSchema = z.object({
  type: z.literal("workspace.handoff.seal_archive.response"),
  payload: z.object({
    requestId: z.string(),
    transferId: HandoffTransferIdSchema,
    result: HandoffArchiveStatusSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffArchiveResetBlobRequestSchema = z.object({
  type: z.literal("workspace.handoff.reset_archive_blob.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  sha256: HandoffDigestSchema,
});
export const HandoffArchiveResetBlobResponseSchema = z.object({
  type: z.literal("workspace.handoff.reset_archive_blob.response"),
  payload: z.object({
    requestId: z.string(),
    transferId: HandoffTransferIdSchema,
    result: z.boolean().nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});
