import { useEffect } from "react";
import { Pressable, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { QuickPromptSendState } from "./deferred-send";
import type { QuickPromptPicker } from "./picker";

const actionKey = {
  send: "quickPrompts.send",
  steer: "quickPrompts.steer",
  queue: "quickPrompts.queue",
  interrupt: "quickPrompts.interrupt",
} as const;
const PROGRESS_HEIGHT = 2;

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
    default:
      throw new Error("unreachable");
  }
}

/**
 * The deferred send's live state: the pending title with Undo and a draining progress line,
 * then its outcome with Retry or dismiss. `toolbar` fits the 28pt split; `bar` sits above the
 * input on the composer's own frame.
 */
export function QuickPromptFeedback({
  variant,
  state,
  undoMs,
  undo,
  retry,
  dismiss,
  sendNow,
  width,
}: {
  variant: "toolbar" | "bar";
  state: QuickPromptSendState;
  undoMs: number;
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
  const pending = state.status === "pending";
  return (
    <View
      style={[
        styles.feedback,
        variant === "bar" ? styles.feedbackBar : styles.feedbackToolbar,
        width === undefined ? null : { width: width - 2 },
      ]}
      accessibilityLiveRegion="polite"
      testID="quick-prompt-feedback"
    >
      <Pressable
        onPress={sendNow}
        disabled={!pending}
        style={styles.feedbackMain}
        accessibilityRole={pending ? "button" : "text"}
        accessibilityLabel={label}
      >
        <Text style={styles.feedbackText} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {pending ? (
        <Button variant="secondary" size="xs" onPress={undo} testID="quick-prompt-undo">
          {t("quickPrompts.undo")}
        </Button>
      ) : null}
      {state.status === "failed" ? (
        <Button variant="secondary" size="xs" onPress={retry} testID="quick-prompt-retry">
          {t("quickPrompts.retry")}
        </Button>
      ) : null}
      {state.status !== "pending" && state.status !== "sending" ? (
        <Button
          variant="ghost"
          size="xs"
          leftIcon={X}
          onPress={dismiss}
          accessibilityLabel={t("quickPrompts.dismiss")}
          testID="quick-prompt-dismiss"
        />
      ) : null}
      {pending ? <UndoProgress state={state} durationMs={undoMs} /> : null}
    </View>
  );
}

/** A line that drains over the undo window, so the wait reads as a wait. */
function UndoProgress({ state, durationMs }: { state: QuickPromptSendState; durationMs: number }) {
  const reduceMotion = useReducedMotion();
  const remaining = useSharedValue(1);
  useEffect(() => {
    remaining.value = 1;
    if (reduceMotion || durationMs <= 0) return;
    remaining.value = withTiming(0, { duration: durationMs, easing: Easing.linear });
    // Every published state is a new capture or retry, which restarts the window.
  }, [durationMs, reduceMotion, remaining, state]);
  const lineStyle = useAnimatedStyle(() => ({ width: `${remaining.value * 100}%` }));
  return (
    <Animated.View style={[progressStyles.line, lineStyle]} pointerEvents="none">
      <View style={styles.progressFill} />
    </Animated.View>
  );
}

/** Above the input, for layouts whose toolbar has no quick-prompt slot to host the feedback. */
export function QuickPromptFeedbackBar({ picker }: { picker: QuickPromptPicker }) {
  if (picker.state.status === "idle") return null;
  return (
    <View testID="quick-prompt-feedback-bar">
      <QuickPromptFeedback
        variant="bar"
        state={picker.state}
        width={undefined}
        undoMs={picker.undoMs}
        undo={picker.binding.controller.cancel}
        retry={picker.retry}
        dismiss={picker.binding.controller.dismiss}
        sendNow={picker.binding.controller.sendNow}
      />
    </View>
  );
}

// Plain React Native styles: the line is driven by Reanimated (docs/unistyles.md).
const progressStyles = RNStyleSheet.create({
  line: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: PROGRESS_HEIGHT,
  },
});

const styles = StyleSheet.create((theme) => ({
  feedback: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    overflow: "hidden",
  },
  // Inside the split: its 28pt box, so the row keeps its centerline.
  feedbackToolbar: {
    height: 28,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[0.5],
  },
  // Above the input: the composer's own frame, radius and inset.
  feedbackBar: {
    minHeight: 32,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[0.5],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  feedbackMain: { flexGrow: 1, flexShrink: 1, minWidth: 0, justifyContent: "center" },
  feedbackText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  progressFill: { flex: 1, backgroundColor: theme.colors.accentBright },
}));
