import { z } from "zod";
import {
  HandoffArchiveManifestSchema,
  HandoffDigestSchema,
  HandoffErrorSchema,
  HandoffTransferIdSchema,
} from "./handoff.js";

export const HandoffGetConversationHistoryRequestSchema = z.object({
  type: z.literal("workspace.handoff.get_conversation_history.request"),
  requestId: z.string(),
  agentId: z.string().min(1),
  cursor: z.object({ epoch: z.string().uuid(), seq: z.number().int().positive() }).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const HandoffConversationIdentitySchema = z.object({
  agentId: z.string().min(1),
  title: z.string().max(4096).nullable(),
  provider: z.string().min(1).max(256),
});
export const HandoffConversationPreviewSchema = z.discriminatedUnion("state", [
  HandoffConversationIdentitySchema.extend({
    state: z.literal("available"),
    provider: z.literal("claude"),
    cliVersion: z.string().min(1).max(128),
    hasWorkflows: z.boolean(),
    artifactBytes: z.number().int().nonnegative().optional(),
  }),
  HandoffConversationIdentitySchema.extend({
    state: z.literal("blocked"),
    reason: z.string().min(1),
  }),
]);
export const HandoffWorkspacePreviewSchema = z.object({
  kind: z.enum(["git", "directory"]),
  fileCount: z.number().int().nonnegative(),
  directoryCount: z.number().int().nonnegative(),
  symlinkCount: z.number().int().nonnegative(),
  fileBytes: z.number().int().nonnegative(),
  gitHistoryBytes: z.number().int().nonnegative(),
  omittedPaths: z.array(z.string().max(4096)).max(50),
  omittedPathCount: z.number().int().nonnegative(),
});
export const HandoffStoppedWorkPreviewSchema = z.object({
  agentIds: z.array(z.string().min(1)).max(1000),
  terminals: z.array(z.object({ id: z.string().min(1), name: z.string().max(4096) })).max(1000),
  setupOperations: z.number().int().nonnegative(),
});
export const HandoffSourcePreviewSchema = z.object({
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  conversations: z.array(HandoffConversationPreviewSchema).max(1000),
  workspace: HandoffWorkspacePreviewSchema.optional(),
  stoppedWork: HandoffStoppedWorkPreviewSchema.optional(),
});
const HandoffContinuationAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
});
export const HandoffDestinationPreviewSchema = z.object({
  conversations: z
    .array(
      HandoffConversationIdentitySchema.extend({
        native: HandoffContinuationAvailabilitySchema,
        context: HandoffContinuationAvailabilitySchema,
      }),
    )
    .max(1000),
});
export type HandoffConversationPreview = z.infer<typeof HandoffConversationPreviewSchema>;
export type HandoffSourcePreview = z.infer<typeof HandoffSourcePreviewSchema>;
export type HandoffDestinationPreview = z.infer<typeof HandoffDestinationPreviewSchema>;

export const HandoffPreviewSourceRequestSchema = z.object({
  type: z.literal("workspace.handoff.preview_source.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
});
export const HandoffPreviewSourceResponseSchema = z.object({
  type: z.literal("workspace.handoff.preview_source.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffSourcePreviewSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});
export const HandoffPreviewDestinationRequestSchema = z.object({
  type: z.literal("workspace.handoff.preview_destination.request"),
  requestId: z.string(),
  conversations: z.array(HandoffConversationPreviewSchema).max(1000),
});
export const HandoffPreviewDestinationResponseSchema = z.object({
  type: z.literal("workspace.handoff.preview_destination.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffDestinationPreviewSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

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

export const HandoffDestinationPageSchema = z.object({
  transfers: z
    .array(
      HandoffDestinationSnapshotSchema.pick({
        transferId: true,
        destinationCwd: true,
        continuationMode: true,
        state: true,
      }),
    )
    .max(20),
  nextCursor: HandoffTransferIdSchema.nullable(),
});
export type HandoffDestinationPage = z.infer<typeof HandoffDestinationPageSchema>;
export const HandoffListDestinationRequestSchema = z.object({
  type: z.literal("workspace.handoff.list_destination.request"),
  requestId: z.string(),
  sourceServerId: z.string().min(1),
  sourceWorkspaceId: z.string().min(1),
  cursor: HandoffTransferIdSchema.optional(),
});
export const HandoffListDestinationResponseSchema = z.object({
  type: z.literal("workspace.handoff.list_destination.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffDestinationPageSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

export const HandoffFindSourceRequestSchema = z.object({
  type: z.literal("workspace.handoff.find_source.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
});
export const HandoffFindSourceResponseSchema = z.object({
  type: z.literal("workspace.handoff.find_source.response"),
  payload: z.object({
    requestId: z.string(),
    result: HandoffSourceStatusSchema.nullable(),
    error: HandoffErrorSchema.nullable(),
  }),
});

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
