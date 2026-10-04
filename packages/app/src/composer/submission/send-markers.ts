import { create } from "zustand";
import type { SendAgentMessageResult } from "@getpaseo/client/internal/daemon-client";

/** How a message this app sent reached the agent, when it was not a plain new turn. */
export type SendMarker = "steered" | "queued";

interface SendMarkerState {
  markers: ReadonlyMap<string, SendMarker>;
}

/**
 * The daemon reports a send's disposition only in its response, and the timeline row carries
 * no trace of it, so the app keeps it for this session by message id.
 */
export const useSendMarkerStore = create<SendMarkerState>(() => ({ markers: new Map() }));

export function recordSendDisposition(
  messageId: string,
  disposition: SendAgentMessageResult["disposition"] | null,
): void {
  if (disposition !== "steered" && disposition !== "queued") return;
  useSendMarkerStore.setState((state) => {
    if (state.markers.get(messageId) === disposition) return state;
    const markers = new Map(state.markers);
    markers.set(messageId, disposition);
    return { markers };
  });
}

export interface SentMessageIdentity {
  messageId?: string;
  clientMessageId?: string;
}

export function resolveSendMarker(
  markers: ReadonlyMap<string, SendMarker>,
  message: SentMessageIdentity,
): SendMarker | null {
  const byMessageId = message.messageId ? markers.get(message.messageId) : undefined;
  const byClientId = message.clientMessageId ? markers.get(message.clientMessageId) : undefined;
  return byMessageId ?? byClientId ?? null;
}
