import { memo, useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Server } from "lucide-react-native";
import type { AgentQueueSnapshot } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { resolveHeldQueueTitleKey } from "./model";

type ResumeState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "failed"; message: string };

const RESUME_IDLE: ResumeState = { status: "idle" };

/** "Queue paused after restart · 2 messages held · Resume", above a held queue. */
export const HeldQueueCallout = memo(function HeldQueueCallout({
  serverId,
  agentId,
  heldReason,
  count,
}: {
  serverId: string;
  agentId: string;
  heldReason: AgentQueueSnapshot["heldReason"];
  count: number;
}): ReactElement {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [resumeState, setResumeState] = useState<ResumeState>(RESUME_IDLE);

  const handleResume = useCallback(async () => {
    if (!client) {
      setResumeState({ status: "failed", message: t("workspace.terminal.hostDisconnected") });
      return;
    }
    setResumeState({ status: "pending" });
    try {
      await client.resumeAgentQueue(agentId);
      setResumeState(RESUME_IDLE);
    } catch (error) {
      setResumeState({ status: "failed", message: toErrorMessage(error) });
    }
  }, [agentId, client, t]);
  const handleResumePress = useCallback(() => {
    void handleResume();
  }, [handleResume]);

  return (
    <View style={styles.stack} testID="held-queue-callout">
      <View style={styles.callout}>
        <ThemedServer size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.text} numberOfLines={2}>
          <Text style={styles.title}>{t(resolveHeldQueueTitleKey(heldReason))}</Text>
          {" · "}
          {t("composer.queue.held.count", { count })}
        </Text>
        <Button
          variant="secondary"
          size="xs"
          onPress={handleResumePress}
          loading={resumeState.status === "pending"}
          testID="held-queue-resume"
        >
          {t("composer.queue.held.resume")}
        </Button>
      </View>
      {resumeState.status === "failed" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("composer.queue.held.resumeFailed", { message: resumeState.message })}
        </Text>
      ) : null}
    </View>
  );
});

const ThemedServer = withUnistyles(Server);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme: Theme) => ({
  stack: {
    alignItems: "center",
    gap: theme.spacing[1],
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 36,
    maxWidth: "100%",
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
  },
  text: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  title: {
    color: theme.colors.foreground,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
