import { Pressable, Text, View } from "react-native";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { QuickPromptSendState } from "./deferred-send";
import type { QuickPromptPicker } from "./picker";

const feedbackKey = {
  started: "quickPrompts.sent",
  steered: "quickPrompts.steered",
  queued: "quickPrompts.queued",
} as const;
const actionKey = {
  send: "quickPrompts.send",
  steer: "quickPrompts.steer",
  queue: "quickPrompts.queue",
  interrupt: "quickPrompts.interrupt",
} as const;

function resolveFeedbackLabel(state: QuickPromptSendState, t: (key: string) => string): string {
  switch (state.status) {
    case "idle":
    case "cancelled":
      return t("quickPrompts.cancelled");
    case "unavailable":
      return t("quickPrompts.unavailable");
    case "pending":
      return `${t(actionKey[state.capture.action])} · ${state.capture.title}`;
    case "sending":
      return t("quickPrompts.sending");
    case "failed":
      return t("quickPrompts.failed");
    case "accepted":
      return t(feedbackKey[state.disposition]);
    default:
      throw new Error("unreachable");
  }
}

/** The deferred send's live state: the pending title with Undo, then its outcome with Retry or dismiss. */
export function QuickPromptFeedback({
  state,
  undo,
  retry,
  dismiss,
  sendNow,
  width,
}: {
  state: QuickPromptSendState;
  dismiss: () => void;
  sendNow: () => void;
  /** Bounded inside the toolbar; undefined stretches across the host. */
  width: number | undefined;
  undo: () => void;
  retry: () => void;
}) {
  const { t } = useTranslation();
  if (state.status === "idle") return null;
  const label = resolveFeedbackLabel(state, t);
  return (
    <View
      style={[styles.feedback, width === undefined ? null : { width: width - 2 }]}
      accessibilityLiveRegion="polite"
      testID="quick-prompt-feedback"
    >
      <Pressable
        onPress={sendNow}
        disabled={state.status !== "pending"}
        style={styles.feedbackMain}
        accessibilityRole={state.status === "pending" ? "button" : "text"}
        accessibilityLabel={label}
      >
        <Text style={styles.feedbackText}>{label}</Text>
      </Pressable>
      {state.status === "pending" ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.feedbackAction}
          textStyle={styles.pillText}
          onPress={undo}
          testID="quick-prompt-undo"
        >
          {t("quickPrompts.undo")}
        </Button>
      ) : null}
      {state.status === "failed" ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.feedbackAction}
          textStyle={styles.pillText}
          onPress={retry}
          testID="quick-prompt-retry"
        >
          {t("quickPrompts.retry")}
        </Button>
      ) : null}
      {state.status !== "pending" && state.status !== "sending" ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.feedbackAction}
          leftIcon={X}
          onPress={dismiss}
          accessibilityLabel={t("quickPrompts.dismiss")}
          testID="quick-prompt-dismiss"
        />
      ) : null}
    </View>
  );
}

/** Above the input, for layouts whose toolbar has no quick-prompt slot to host the feedback. */
export function QuickPromptFeedbackBar({ picker }: { picker: QuickPromptPicker }) {
  if (picker.state.status === "idle") return null;
  return (
    <View style={styles.bar} testID="quick-prompt-feedback-bar">
      <QuickPromptFeedback
        state={picker.state}
        width={undefined}
        undo={picker.binding.controller.cancel}
        retry={picker.retry}
        dismiss={picker.binding.controller.dismiss}
        sendNow={picker.binding.controller.sendNow}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  pillText: { flexShrink: 1, minWidth: 0 },
  feedback: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    paddingHorizontal: theme.spacing[1],
    minHeight: 44,
  },
  feedbackAction: {
    maxWidth: "100%",
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 4,
    flexShrink: 1,
  },
  feedbackMain: { flexGrow: 1, flexShrink: 1, minHeight: 44, justifyContent: "center" },
  feedbackText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
