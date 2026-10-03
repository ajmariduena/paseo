import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import type { ComposerAttachment } from "@/attachments/types";
import type { ContextWindowCompaction } from "@/components/context-window-meter";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { queueComposerMessage, type QueueWriter } from "@/composer/actions";
import {
  canCompactConversation,
  COMPACT_COMMAND_TEXT,
  resolveCompactTiming,
} from "@/composer/compaction/model";
import { useToast } from "@/contexts/toast-context";
import { useAgentCommandsQuery } from "@/hooks/use-agent-commands-query";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";

function resolveAgentLabel(provider: string | null): string {
  if (!provider) return "";
  return AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === provider)?.label ?? provider;
}

/**
 * The context meter's compact action. It sends the same `/compact` a user would type: providers
 * that own the command intercept it, so no daemon support is involved. While a turn runs it joins
 * the composer's queue instead of interrupting, and it never touches the draft.
 */
export function useCompactConversation(input: {
  serverId: string;
  agentId: string;
  provider: string | null;
  usedTokens: number | null;
  isAgentRunning: boolean;
  submitMessage: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
  queueWriter: QueueWriter;
}): ContextWindowCompaction | null {
  const { serverId, agentId, provider, usedTokens, isAgentRunning, submitMessage, queueWriter } =
    input;
  const { t } = useTranslation();
  const toast = useToast();
  const hasUsage = usedTokens !== null;
  const { commands } = useAgentCommandsQuery({ serverId, agentId, enabled: hasUsage });
  const available = canCompactConversation({ commands, hasUsage });

  const compact = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("contextWindow.compact.confirmTitle"),
      message: t("contextWindow.compact.confirmMessage", {
        agent: resolveAgentLabel(provider),
        tokens: formatTokenCount(usedTokens ?? 0),
      }),
      confirmLabel: t("contextWindow.compact.confirm"),
      cancelLabel: t("common.actions.cancel"),
    });
    if (!confirmed) return;
    // The turn may have ended while the dialog was open, so the timing is read again here.
    const running = selectAgentTurnPresentation(
      useSessionStore.getState().sessions[serverId],
      agentId,
    ).isActive;
    if (resolveCompactTiming(running) === "after-turn") {
      queueComposerMessage({
        agentId,
        text: COMPACT_COMMAND_TEXT,
        attachments: [],
        queue: queueWriter,
      });
      return;
    }
    try {
      await submitMessage(COMPACT_COMMAND_TEXT, []);
    } catch (error) {
      console.error("[Composer] Failed to compact the conversation:", error);
      toast.error(t("contextWindow.compact.failed"));
    }
  }, [agentId, provider, queueWriter, serverId, submitMessage, t, toast, usedTokens]);

  const handleCompact = useCallback(() => {
    void compact();
  }, [compact]);

  const timing = resolveCompactTiming(isAgentRunning);
  return useMemo(
    () => (available ? { timing, onCompact: handleCompact } : null),
    [available, handleCompact, timing],
  );
}
