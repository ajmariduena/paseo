import { useCallback, useMemo, useRef } from "react";
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from "react-native";
import { continueChecklist, type TextEdit, type TextSelection } from "./model";
import type { ChecklistKeys, ChecklistKeysInput } from "./use-checklist-keys.types";

/**
 * Native can't cancel Enter, so a newline typed at the tracked caret is rewritten after the fact.
 * onSelectionChange lands after onChangeText, so the tracked caret is still the pre-keystroke one.
 */
export function useChecklistKeys(_input: ChecklistKeysInput): ChecklistKeys {
  const selectionRef = useRef<TextSelection>({ start: 0, end: 0 });

  const onSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selectionRef.current = event.nativeEvent.selection;
    },
    [],
  );

  const interceptChange = useCallback((previous: string, next: string): TextEdit | null => {
    const { start, end } = selectionRef.current;
    if (start !== end || next !== `${previous.slice(0, start)}\n${previous.slice(start)}`) {
      return null;
    }
    const edit = continueChecklist(previous, selectionRef.current);
    if (edit) selectionRef.current = edit.selection;
    return edit;
  }, []);

  const getSelection = useCallback(() => selectionRef.current, []);

  return useMemo(
    () => ({ inputProps: { onSelectionChange }, interceptChange, getSelection }),
    [getSelection, interceptChange, onSelectionChange],
  );
}
