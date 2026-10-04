import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
  /** Overrides the default send setting for this message, from the alternate send actions. */
  activeTurnBehavior?: ActiveTurnSendBehavior;
}

export type ActiveTurnSendBehavior = Extract<ActiveTurnBehavior, "interrupt" | "steer">;

export interface TextReplacement {
  key: string;
  text: string;
}
