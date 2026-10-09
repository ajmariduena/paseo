import { z } from "zod";
import {
  HandoffArchiveManifestSchema,
  HandoffDigestSchema,
  HandoffErrorSchema,
  HandoffTransferIdSchema,
} from "./handoff.js";

export const HandoffSourceInspectionSchema = z.object({
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  agentIds: z.array(z.string().min(1)).max(1000),
});
export const HandoffSourceStatusSchema = HandoffSourceInspectionSchema.extend({
  id: HandoffTransferIdSchema,
  destinationServerId: z.string().min(1),
  reservationId: HandoffTransferIdSchema,
  state: z.enum(["preparing", "ready", "released", "cancelled"]),
  manifestDigest: HandoffDigestSchema.nullable(),
  publicKey: z.string().min(1).max(1024),
});
export const HandoffSourceSnapshotSchema = z.object({
  source: HandoffSourceStatusSchema,
  manifest: HandoffArchiveManifestSchema.nullable(),
});
export const HandoffReleaseBindingSchema = z.object({
  version: z.literal(1),
  transferId: HandoffTransferIdSchema,
  sourceServerId: z.string().min(1),
  destinationServerId: z.string().min(1),
  reservationId: HandoffTransferIdSchema,
  manifestDigest: HandoffDigestSchema,
});
export const HandoffReleaseReceiptSchema = HandoffReleaseBindingSchema.extend({
  signature: z.string().min(1).max(1024),
});
export type HandoffReleaseReceipt = z.infer<typeof HandoffReleaseReceiptSchema>;
export const HandoffCancellationBindingSchema = z.object({
  version: z.literal(1),
  outcome: z.literal("cancelled"),
  transferId: HandoffTransferIdSchema,
  sourceServerId: z.string().min(1),
  destinationServerId: z.string().min(1),
  reservationId: HandoffTransferIdSchema,
});
export const HandoffCancellationProofSchema = z.object({
  receipt: HandoffCancellationBindingSchema.extend({ signature: z.string().min(1).max(1024) }),
  publicKey: z.string().min(1).max(1024),
});
export type HandoffCancellationProof = z.infer<typeof HandoffCancellationProofSchema>;
export const HandoffDestinationSnapshotSchema = z.object({
  transferId: HandoffTransferIdSchema,
  reservationId: HandoffTransferIdSchema,
  sourceServerId: z.string().min(1),
  sourceWorkspaceId: z.string().min(1),
  sourceAgentIds: z.array(z.string().min(1)).max(1000),
  destinationParent: z.string().min(1),
  destinationCwd: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  agentMappings: z
    .array(z.object({ sourceAgentId: z.string().min(1), destinationAgentId: z.string().uuid() }))
    .max(1000),
  continuationMode: z.enum(["native", "context"]),
  state: z.enum([
    "reserved",
    "receiving",
    "staged",
    "released",
    "activating",
    "active",
    "cancelled",
  ]),
  manifestDigest: HandoffDigestSchema.nullable(),
});
export type HandoffSourceSnapshot = z.infer<typeof HandoffSourceSnapshotSchema>;
export type HandoffDestinationSnapshot = z.infer<typeof HandoffDestinationSnapshotSchema>;

export const HandoffInspectSourceRequestSchema = z.object({
  type: z.literal("workspace.handoff.inspect_source.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
});
export const HandoffInspectSourceResponseSchema = z.object({
  type: z.literal("workspace.handoff.inspect_source.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffSourceInspectionSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffPrepareSourceRequestSchema = z.object({
  type: z.literal("workspace.handoff.prepare_source.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  workspaceId: z.string().min(1),
  agentIds: z.array(z.string().min(1)).max(1000),
  destinationServerId: z.string().min(1),
  reservationId: HandoffTransferIdSchema,
});
export const HandoffPrepareSourceResponseSchema = z.object({
  type: z.literal("workspace.handoff.prepare_source.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffSourceSnapshotSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffGetSourceStatusRequestSchema = z.object({
  type: z.literal("workspace.handoff.get_source_status.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
});
export const HandoffGetSourceStatusResponseSchema = z.object({
  type: z.literal("workspace.handoff.get_source_status.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffSourceSnapshotSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffReleaseSourceRequestSchema = z.object({
  type: z.literal("workspace.handoff.release_source.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
});
export const HandoffReleaseSourceResponseSchema = z.object({
  type: z.literal("workspace.handoff.release_source.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffReleaseReceiptSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffReserveDestinationRequestSchema = z.object({
  type: z.literal("workspace.handoff.reserve_destination.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  sourceServerId: z.string().min(1),
  sourceWorkspaceId: z.string().min(1),
  sourceAgentIds: z.array(z.string().min(1)).max(1000),
  destinationParent: z.string().min(1),
  continuationMode: z.enum(["native", "context"]),
});
export const HandoffReserveDestinationResponseSchema = z.object({
  type: z.literal("workspace.handoff.reserve_destination.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffDestinationSnapshotSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffBindDestinationRequestSchema = z.object({
  type: z.literal("workspace.handoff.bind_destination.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  publicKey: z.string().min(1).max(1024),
  manifest: HandoffArchiveManifestSchema,
});
export const HandoffBindDestinationResponseSchema = z.object({
  type: z.literal("workspace.handoff.bind_destination.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffDestinationSnapshotSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffStageDestinationRequestSchema = z.object({
  type: z.literal("workspace.handoff.stage_destination.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
});
export const HandoffStageDestinationResponseSchema = z.object({
  type: z.literal("workspace.handoff.stage_destination.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffDestinationSnapshotSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffGetDestinationStatusRequestSchema = z.object({
  type: z.literal("workspace.handoff.get_destination_status.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
});
export const HandoffGetDestinationStatusResponseSchema = z.object({
  type: z.literal("workspace.handoff.get_destination_status.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffDestinationSnapshotSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffActivateDestinationRequestSchema = z.object({
  type: z.literal("workspace.handoff.activate_destination.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  receipt: HandoffReleaseReceiptSchema.optional(),
});
export const HandoffActivateDestinationResponseSchema = z.object({
  type: z.literal("workspace.handoff.activate_destination.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffDestinationSnapshotSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffCancelSourceRequestSchema = z.object({
  type: z.literal("workspace.handoff.cancel_source.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  destinationServerId: z.string().min(1),
  reservationId: HandoffTransferIdSchema,
});
export const HandoffCancelSourceResponseSchema = z.object({
  type: z.literal("workspace.handoff.cancel_source.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffCancellationProofSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});
export const HandoffCancelDestinationRequestSchema = z.object({
  type: z.literal("workspace.handoff.cancel_destination.request"),
  requestId: z.string(),
  transferId: HandoffTransferIdSchema,
  proof: HandoffCancellationProofSchema,
});
export const HandoffCancelDestinationResponseSchema = z.object({
  type: z.literal("workspace.handoff.cancel_destination.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffDestinationSnapshotSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});
