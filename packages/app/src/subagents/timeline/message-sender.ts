import type { TFunction } from "i18next";
import type { MessageOrigin } from "@getpaseo/protocol/agent-types";
import { resolveRowLabel } from "../track-presentation";

/** The agent that wrote a user message through its Paseo tools, if one did. */
export function readAgentMessageSender(origin: MessageOrigin | undefined): string | null {
  return origin?.kind === "agent" ? origin.agentId : null;
}

/** "Sent by {title}", or "Sent by an agent" until the sender's title is known. */
export function formatSentByLabel(t: TFunction, senderTitle: string | null | undefined): string {
  const title = resolveRowLabel(senderTitle);
  return title ? t("message.attribution.sentBy", { title }) : t("message.attribution.sentByAgent");
}
