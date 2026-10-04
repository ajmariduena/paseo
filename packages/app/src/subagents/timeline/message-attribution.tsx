import { memo, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { useOpenSubagent } from "../use-open-subagent";
import { formatSentByLabel } from "./message-sender";

/** "Sent by {sender}" above a user message another agent wrote; pressing it opens the sender. */
export const AgentMessageAttribution = memo(function AgentMessageAttribution({
  senderAgentId,
}: {
  senderAgentId: string;
}): ReactElement {
  const { t } = useTranslation();
  const { serverId, workspaceId, tabId, openTab } = usePaneContext();
  const { openParent } = useOpenSubagent({ serverId, workspaceId, parentTabId: tabId, openTab });
  const senderTitle = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (session?.agents.get(senderAgentId) ?? session?.agentDetails.get(senderAgentId))?.title;
  });
  const label = formatSentByLabel(t, senderTitle);
  const handlePress = useCallback(() => openParent(senderAgentId), [openParent, senderAgentId]);

  return (
    <Button
      variant="ghost"
      size="xs"
      onPress={handlePress}
      accessibilityLabel={label}
      numberOfLines={1}
      style={styles.button}
      textStyle={styles.label}
      testID="user-message-attribution"
    >
      {label}
    </Button>
  );
});

const styles = StyleSheet.create(() => ({
  button: {
    alignSelf: "flex-end",
    maxWidth: "100%",
  },
  label: {
    flexShrink: 1,
  },
}));
