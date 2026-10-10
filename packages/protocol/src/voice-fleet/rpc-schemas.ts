import { z } from "zod";
import {
  VoiceFleetDigestSchema,
  VoiceFleetHostStateSchema,
  VoiceToolResultSchema,
} from "./types.js";

/** This host's agents, workspaces and projects, for a voice call running on another host. */
export const VoiceFleetDigestRequestSchema = z.object({
  type: z.literal("voice.fleet.digest.request"),
  language: z.string().optional(),
  requestId: z.string(),
});

export const VoiceFleetDigestResponseSchema = z.object({
  type: z.literal("voice.fleet.digest.response"),
  payload: z.object({
    requestId: z.string(),
    digest: VoiceFleetDigestSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/**
 * The phone forwards the other hosts' state to the host running the call and proves it is
 * alive. The sending client also becomes the courier for actions on those hosts.
 */
export const VoiceFleetSyncRequestSchema = z.object({
  type: z.literal("voice.fleet.sync.request"),
  hosts: z.array(VoiceFleetHostStateSchema),
  /** The name the user gave the host running the call, as the phone shows it. */
  selfLabel: z.string().optional(),
  appState: z.string().optional(),
  requestId: z.string(),
});

export const VoiceFleetSyncResponseSchema = z.object({
  type: z.literal("voice.fleet.sync.response"),
  payload: z.object({
    requestId: z.string(),
    /** False when no call runs here; the phone stops syncing. */
    active: z.boolean(),
  }),
});

/** Pushed by the host running the call: run this voice tool on another host. */
export const VoiceCourierExecuteMessageSchema = z.object({
  type: z.literal("voice.courier.execute"),
  payload: z.object({
    operationId: z.string(),
    serverId: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    language: z.string().nullable().optional(),
  }),
});

/** Runs one voice tool on this host. A repeated operationId returns the first result. */
export const VoiceToolsInvokeRequestSchema = z.object({
  type: z.literal("voice.tools.invoke.request"),
  operationId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  language: z.string().optional(),
  requestId: z.string(),
});

export const VoiceToolsInvokeResponseSchema = z.object({
  type: z.literal("voice.tools.invoke.response"),
  payload: z.object({
    requestId: z.string(),
    operationId: z.string(),
    result: VoiceToolResultSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** The phone hands back the result of a courier operation. */
export const VoiceCourierResultRequestSchema = z.object({
  type: z.literal("voice.courier.result.request"),
  operationId: z.string(),
  result: VoiceToolResultSchema.nullable(),
  error: z.string().nullable(),
  requestId: z.string(),
});

export const VoiceCourierResultResponseSchema = z.object({
  type: z.literal("voice.courier.result.response"),
  payload: z.object({
    requestId: z.string(),
  }),
});
