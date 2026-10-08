import { useCallback, useMemo, useRef } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import { continueChecklist, toggleChecklistLine, type TextSelection } from "./model";
import type { ChecklistKeys, ChecklistKeysInput } from "./use-checklist-keys.types";

interface WebKeyEvent extends TextInputKeyPressEventData {
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

interface WebTextArea {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/** Web sees keydown before the browser edits the text, so Enter is intercepted outright. */
export function useChecklistKeys({ applyEdit, getInput }: ChecklistKeysInput): ChecklistKeys {
  const applyRef = useRef(applyEdit);
  applyRef.current = applyEdit;

  const getSelection = useCallback((): TextSelection => {
    const input = getInput() as WebTextArea | null;
    return { start: input?.selectionStart ?? 0, end: input?.selectionEnd ?? 0 };
  }, [getInput]);

  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const native = event.nativeEvent as WebKeyEvent;
      if (native.key !== "Enter" || native.isComposing || native.altKey || native.shiftKey) return;
      const input = getInput() as WebTextArea | null;
      if (!input) return;
      const edit =
        native.metaKey || native.ctrlKey
          ? toggleChecklistLine(input.value, getSelection())
          : continueChecklist(input.value, getSelection());
      if (!edit) return;
      event.preventDefault();
      applyRef.current(edit);
    },
    [getInput, getSelection],
  );

  return useMemo(
    () => ({ inputProps: { onKeyPress }, interceptChange: () => null, getSelection }),
    [getSelection, onKeyPress],
  );
}
