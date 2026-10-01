import { z } from "zod";
import {
  BrowserAutomationBackCommandSchema,
  BrowserAutomationBrowserIdSchema,
  BrowserAutomationCloseTabCommandSchema,
  BrowserAutomationErrorCodeSchema,
  BrowserAutomationErrorSchema,
  BrowserAutomationResultSchema,
  BrowserAutomationForwardCommandSchema,
  BrowserAutomationListTabsCommandSchema,
  BrowserAutomationNavigateCommandSchema,
  BrowserAutomationNewTabCommandSchema,
  BrowserAutomationReloadCommandSchema,
} from "../browser-automation/rpc-schemas.js";

const StreamIdSchema = z.string().uuid();
const SequenceSchema = z.number().int().nonnegative().max(0xffffffff);
const CssCoordinateSchema = z.number().finite().min(0).max(100_000);
const WheelDeltaSchema = z.number().finite().min(-100_000).max(100_000);

export const BrowserScreencastErrorSchema = z.object({
  code: BrowserAutomationErrorCodeSchema,
  message: z.string().min(1),
});

export const BrowserScreencastCaptureSchema = z.object({
  maxWidth: z.number().int().min(64).max(4096),
  maxHeight: z.number().int().min(64).max(4096),
  quality: z.number().int().min(10).max(95).optional(),
});

export const BrowserScreencastPageStateSchema = z.object({
  url: z.string().max(8192),
  title: z.string().max(1024),
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});

export const BrowserScreencastInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    x: CssCoordinateSchema,
    y: CssCoordinateSchema,
    button: z.enum(["left", "right"]).optional(),
  }),
  z.object({
    kind: z.literal("wheel"),
    x: CssCoordinateSchema,
    y: CssCoordinateSchema,
    deltaX: WheelDeltaSchema,
    deltaY: WheelDeltaSchema,
  }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal("key"), key: z.string().min(1).max(32) }),
  /** Without `mobile` the page lays out at the desktop viewport again. */
  z.object({
    kind: z.literal("viewport"),
    mobile: z
      .object({
        width: z.number().int().min(200).max(4096),
        height: z.number().int().min(200).max(4096),
        deviceScaleFactor: z.number().finite().min(1).max(4),
      })
      .optional(),
  }),
]);

/** The page commands a remote viewer may issue; agent-only commands such as evaluate are excluded. */
export const BrowserRemoteCommandSchema = z.discriminatedUnion("command", [
  BrowserAutomationListTabsCommandSchema,
  BrowserAutomationNewTabCommandSchema,
  BrowserAutomationNavigateCommandSchema,
  BrowserAutomationBackCommandSchema,
  BrowserAutomationForwardCommandSchema,
  BrowserAutomationReloadCommandSchema,
  BrowserAutomationCloseTabCommandSchema,
]);

export const BrowserRemoteHostSchema = z.object({
  hostId: z.string().min(1),
  hostKind: z.string(),
  screencast: z.boolean(),
});

// Viewer → daemon

export const BrowserRemoteListHostsRequestSchema = z.object({
  type: z.literal("browser.remote.list_hosts.request"),
  requestId: z.string().min(1),
});

export const BrowserRemoteExecuteRequestSchema = z.object({
  type: z.literal("browser.remote.execute.request"),
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  hostId: z.string().min(1).optional(),
  command: BrowserRemoteCommandSchema,
});

export const BrowserRemoteScreencastSubscribeRequestSchema = z.object({
  type: z.literal("browser.remote.screencast.subscribe.request"),
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  browserId: BrowserAutomationBrowserIdSchema,
  capture: BrowserScreencastCaptureSchema,
});

/** Returns frame credit to the daemon. It has no response. */
export const BrowserRemoteScreencastAckFrameRequestSchema = z.object({
  type: z.literal("browser.remote.screencast.ack_frame.request"),
  subscriptionId: z.string().min(1),
  sequence: SequenceSchema,
});

export const BrowserRemoteInputRequestSchema = z.object({
  type: z.literal("browser.remote.input.request"),
  requestId: z.string().min(1),
  subscriptionId: z.string().min(1),
  input: BrowserScreencastInputSchema,
});

// Daemon → viewer

export const BrowserRemoteListHostsResponseSchema = z.object({
  type: z.literal("browser.remote.list_hosts.response"),
  payload: z.object({
    requestId: z.string(),
    hosts: z.array(BrowserRemoteHostSchema),
  }),
});

// zod-aot compiles a boolean discriminator as strings, so this outbound payload stays flat.
export const BrowserRemoteExecuteResponseSchema = z.object({
  type: z.literal("browser.remote.execute.response"),
  payload: z.object({
    requestId: z.string().min(1),
    ok: z.boolean(),
    result: BrowserAutomationResultSchema.optional(),
    error: BrowserAutomationErrorSchema.optional(),
  }),
});

export const BrowserRemoteScreencastSubscribeResponseSchema = z.object({
  type: z.literal("browser.remote.screencast.subscribe.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    page: BrowserScreencastPageStateSchema.optional(),
    error: z.string().optional(),
    code: BrowserAutomationErrorCodeSchema.optional(),
  }),
});

export const BrowserRemoteScreencastUpdateSchema = z.object({
  type: z.literal("browser.remote.screencast.update"),
  payload: z.object({
    subscriptionId: z.string(),
    event: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("page"), page: BrowserScreencastPageStateSchema }),
      z.object({ kind: z.literal("ended"), error: BrowserScreencastErrorSchema }),
    ]),
  }),
});

export const BrowserRemoteInputResponseSchema = z.object({
  type: z.literal("browser.remote.input.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: BrowserScreencastErrorSchema.optional(),
  }),
});

// Daemon → browser host

export const BrowserHostScreencastStartRequestSchema = z.object({
  type: z.literal("browser.host.screencast.start.request"),
  subscriptionId: z.string().optional(),
  requestId: z.string().min(1),
  streamId: StreamIdSchema,
  browserId: BrowserAutomationBrowserIdSchema,
  workspaceId: z.string().min(1),
  capture: BrowserScreencastCaptureSchema,
});

/** Ends a host stream. It has no response. */
export const BrowserHostScreencastStopRequestSchema = z.object({
  type: z.literal("browser.host.screencast.stop.request"),
  subscriptionId: z.string().optional(),
  streamId: StreamIdSchema,
});

/** Returns frame credit to the host. It has no response. */
export const BrowserHostScreencastAckFrameRequestSchema = z.object({
  type: z.literal("browser.host.screencast.ack_frame.request"),
  subscriptionId: z.string().optional(),
  streamId: StreamIdSchema,
  sequence: SequenceSchema,
});

export const BrowserHostScreencastInputRequestSchema = z.object({
  type: z.literal("browser.host.screencast.input.request"),
  subscriptionId: z.string().optional(),
  requestId: z.string().min(1),
  streamId: StreamIdSchema,
  input: BrowserScreencastInputSchema,
});

// Browser host → daemon

export const BrowserHostScreencastStartResponseSchema = z.object({
  type: z.literal("browser.host.screencast.start.response"),
  payload: z.object({
    requestId: z.string().min(1),
    ok: z.boolean(),
    page: BrowserScreencastPageStateSchema.optional(),
    error: BrowserScreencastErrorSchema.optional(),
  }),
});

export const BrowserHostScreencastInputResponseSchema = z.object({
  type: z.literal("browser.host.screencast.input.response"),
  payload: z.object({
    requestId: z.string().min(1),
    ok: z.boolean(),
    error: BrowserScreencastErrorSchema.optional(),
  }),
});

/** Host-initiated stream event. It has no response. */
export const BrowserHostScreencastReportRequestSchema = z.object({
  type: z.literal("browser.host.screencast.report.request"),
  streamId: StreamIdSchema,
  event: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("page"), page: BrowserScreencastPageStateSchema }),
    z.object({ kind: z.literal("ended"), error: BrowserScreencastErrorSchema }),
  ]),
});

export type BrowserScreencastCapture = z.infer<typeof BrowserScreencastCaptureSchema>;
export type BrowserScreencastPageState = z.infer<typeof BrowserScreencastPageStateSchema>;
export type BrowserScreencastInput = z.infer<typeof BrowserScreencastInputSchema>;
export type BrowserScreencastError = z.infer<typeof BrowserScreencastErrorSchema>;
export type BrowserRemoteCommand = z.infer<typeof BrowserRemoteCommandSchema>;
export type BrowserRemoteHost = z.infer<typeof BrowserRemoteHostSchema>;
export type BrowserHostScreencastStartRequest = z.infer<
  typeof BrowserHostScreencastStartRequestSchema
>;
export type BrowserHostScreencastInputRequest = z.infer<
  typeof BrowserHostScreencastInputRequestSchema
>;
