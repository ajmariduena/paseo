import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { VoiceMessagesItem } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import type { VoiceMessagesTransport } from "@/voice-chat/messages/messages-controller";

/**
 * Messages-mode transport over a host's daemon connection. The client is looked up per
 * call and update listeners follow it, because the host runtime can swap clients on reconnect.
 */
export function createHostVoiceMessagesTransport(params: {
  serverId: string;
  language: string | undefined;
  history?: () => string[];
}): VoiceMessagesTransport {
  const store = getHostRuntimeStore();
  const { serverId } = params;

  function requireClient(): DaemonClient {
    const client = store.getClient(serverId);
    if (!client) throw new Error("disconnected");
    return client;
  }

  return {
    async start({ callId, greet }) {
      const history = params.history?.() ?? [];
      return requireClient().startVoiceMessages({
        callId,
        greet,
        ...(params.language ? { language: params.language } : {}),
        ...(history.length > 0 ? { history } : {}),
      });
    },
    sendUtterance: (request) => requireClient().sendVoiceUtterance(request),
    sync: (request) => requireClient().syncVoiceMessages(request),
    getAudio: (request) => requireClient().getVoiceMessageAudio(request),
    end: (request) => requireClient().endVoiceMessages(request),
    isConnected: () => isHostRuntimeConnected(store.getSnapshot(serverId)),
    subscribeConnection(listener) {
      let connected = isHostRuntimeConnected(store.getSnapshot(serverId));
      return store.subscribe(serverId, () => {
        const next = isHostRuntimeConnected(store.getSnapshot(serverId));
        if (next === connected) return;
        connected = next;
        listener(next);
      });
    },
    subscribeUpdates(listener: (callId: string, item: VoiceMessagesItem) => void) {
      let client: DaemonClient | null = null;
      let unsubscribe: (() => void) | null = null;
      const attach = () => {
        const next = store.getClient(serverId);
        if (next === client) return;
        unsubscribe?.();
        client = next;
        unsubscribe =
          next?.on("voice.messages.update", (message) => {
            if (message.type !== "voice.messages.update") return;
            listener(message.payload.callId, message.payload.item);
          }) ?? null;
      };
      attach();
      const unsubscribeStore = store.subscribe(serverId, attach);
      return () => {
        unsubscribeStore();
        unsubscribe?.();
      };
    },
  };
}
