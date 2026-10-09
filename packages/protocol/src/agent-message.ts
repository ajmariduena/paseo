import { z } from "zod";

/** Semantic provenance, independent of provider envelopes and timeline presentation. */
export const AgentMessageSchema = z.object({
  event: z.enum(["message", "finished", "errored", "permission-required", "closed"]),
  sender: z.object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    workspaceTitle: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  }),
  /** A peer is an agent in another session, not the receiver's parent or child. */
  relation: z.enum(["peer"]).optional(),
  text: z.string(),
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
