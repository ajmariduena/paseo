import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { recordSendDisposition } from "@/composer/submission/send-markers";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import { forgetQueuedText } from "./queued-text";

export type QueueEntryAction = "remove" | "edit" | "move" | "sendNow";

/** One queue action runs at a time; its failure stays under the row until the next action. */
export type QueueActionState =
  | { status: "idle" }
  | { status: "pending"; entryId: string; action: QueueEntryAction }
  | { status: "failed"; entryId: string; action: QueueEntryAction; message: string };

export const IDLE_QUEUE_ACTION: QueueActionState = { status: "idle" };

export type RunQueueAction = (
  entryId: string,
  action: QueueEntryAction,
  operation: (client: DaemonClient) => Promise<unknown>,
) => Promise<void>;

export interface ServerQueueActions {
  state: QueueActionState;
  run: RunQueueAction;
  /** Steers the entry into the running turn, or starts it when the agent is idle. */
  sendNow: (entryId: string) => void;
}

/**
 * Owned by the composer rather than the queue track, so the steer-first-queued shortcut shows
 * its progress and failure on the row it acted on.
 */
export function useServerQueueActions(serverId: string, agentId: string): ServerQueueActions {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<QueueActionState>(IDLE_QUEUE_ACTION);

  const run = useCallback<RunQueueAction>(
    async (entryId, action, operation) => {
      if (!client) {
        const message = t("workspace.terminal.hostDisconnected");
        setState({ status: "failed", entryId, action, message });
        return;
      }
      setState({ status: "pending", entryId, action });
      try {
        await operation(client);
        setState(IDLE_QUEUE_ACTION);
      } catch (error) {
        setState({ status: "failed", entryId, action, message: toErrorMessage(error) });
      }
    },
    [client, t],
  );

  const sendNow = useCallback(
    (entryId: string) => {
      void run(entryId, "sendNow", async (activeClient) => {
        const response = await activeClient.promoteQueuedAgentMessageToSteer(agentId, entryId);
        recordSendDisposition(entryId, response.disposition);
        forgetQueuedText(entryId);
      });
    },
    [agentId, run],
  );

  return useMemo(() => ({ state, run, sendNow }), [run, sendNow, state]);
}
