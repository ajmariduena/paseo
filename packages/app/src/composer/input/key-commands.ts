import type { MessagePayload } from "@/composer/types";
import { useNativeKeyCommandLayer } from "@/hooks/use-native-key-command-layer";
import {
  nativeKeyCommandForCombo,
  type NativeKeyCommandEvent,
} from "@/keyboard/native-key-commands";

const MODIFIED_SEND_COMMAND = nativeKeyCommandForCombo("Cmd+Enter", {
  inTextInput: true,
  outsideTextInput: false,
});
const MESSAGE_INPUT_KEY_COMMANDS = [MODIFIED_SEND_COMMAND];

interface UseMessageInputKeyCommandsInput {
  isFocused: boolean;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  disabled: boolean;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  sendDefault: () => void;
  sendAlternate: () => void;
}

/**
 * Return stays on the dedicated submit path. The layer is registered for as long
 * as the composer is focused, which is how global shortcuts learn the focus scope.
 */
export function useMessageInputKeyCommands(input: UseMessageInputKeyCommandsInput) {
  useNativeKeyCommandLayer({
    enabled: input.isFocused,
    commands: MESSAGE_INPUT_KEY_COMMANDS,
    priority: 1,
    focusScope: "message-input",
    handle: (event: NativeKeyCommandEvent) => {
      if (event.id !== MODIFIED_SEND_COMMAND.id) return false;
      if (input.isSubmitDisabled || input.isSubmitLoading || input.disabled) return true;
      if (input.isAgentRunning && input.onQueue) {
        input.sendAlternate();
      } else {
        input.sendDefault();
      }
      return true;
    },
  });
}
