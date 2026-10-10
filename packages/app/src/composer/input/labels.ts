import type { TFunction } from "i18next";
import type { SendBehavior } from "@/hooks/use-settings/storage";
import type { ComposerSendAction } from "./state";

const SEND_ACTION_LABEL_KEYS: Record<ComposerSendAction, string> = {
  steer: "composer.input.sendAndSteer",
  queue: "composer.input.queueMessage",
  interrupt: "composer.input.sendAndInterrupt",
};

export function resolveSendActionLabel(action: ComposerSendAction, t: TFunction): string {
  return t(SEND_ACTION_LABEL_KEYS[action]);
}

/**
 * What Cmd/Ctrl+Enter does while a turn runs, for the send tooltip's second row: the opposite of
 * the default, as `runAlternateSendAction` resolves it. Null when it does nothing.
 */
export function resolveAlternateSendTooltipLabel(input: {
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  canQueue: boolean;
  t: TFunction;
}): string | null {
  if (!input.isAgentRunning) return null;
  if (input.defaultSendBehavior === "queue") return resolveSendActionLabel("interrupt", input.t);
  return input.canQueue ? resolveSendActionLabel("queue", input.t) : null;
}

export function resolveSubmitAccessibilityLabel(input: {
  submitButtonAccessibilityLabel: string | undefined;
  canPressLoadingButton: boolean;
  defaultActionQueues: boolean;
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  t: TFunction;
}): string {
  if (input.submitButtonAccessibilityLabel) return input.submitButtonAccessibilityLabel;
  if (input.canPressLoadingButton) return input.t("composer.input.interruptAgent");
  if (input.defaultActionQueues) return input.t("composer.input.queueMessage");
  if (input.isAgentRunning) {
    return input.t(
      input.defaultSendBehavior === "steer"
        ? "composer.input.sendAndSteer"
        : "composer.input.sendAndInterrupt",
    );
  }
  return input.t("composer.input.sendMessage");
}

export function resolveVoiceAccessibilityLabel(input: {
  isDictating: boolean;
  t: TFunction;
}): string {
  if (input.isDictating) return input.t("composer.voice.stopDictation");
  return input.t("composer.voice.startDictation");
}

export function resolveVoiceTooltipText(input: {
  dictationModelLabel?: string | null;
  t: TFunction;
}): string {
  const dictation = input.t("composer.voice.dictation");
  return input.dictationModelLabel ? `${dictation} · ${input.dictationModelLabel}` : dictation;
}

export function resolveSendTooltipLabel(input: {
  submitButtonAccessibilityLabel: string | undefined;
  defaultActionQueues: boolean;
  t: TFunction;
}): string {
  if (input.submitButtonAccessibilityLabel) return input.submitButtonAccessibilityLabel;
  return input.defaultActionQueues
    ? input.t("composer.input.queue")
    : input.t("composer.input.send");
}
