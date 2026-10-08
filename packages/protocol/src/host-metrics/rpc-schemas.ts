import { z } from "zod";
import { HostMetricsSnapshotSchema } from "./types.js";

export const HostMetricsGetRequestSchema = z.object({
  type: z.literal("host.metrics.get.request"),
  requestId: z.string(),
});

export const HostMetricsGetResponseSchema = z.object({
  type: z.literal("host.metrics.get.response"),
  payload: z.object({
    requestId: z.string(),
    metrics: HostMetricsSnapshotSchema,
  }),
});
