import type { TextInputProps } from "react-native";
import type { TextEdit, TextSelection } from "./model";

export interface ChecklistKeysInput {
  applyEdit: (edit: TextEdit) => void;
  getInput: () => unknown;
}

export interface ChecklistKeys {
  inputProps: Pick<TextInputProps, "onKeyPress" | "onSelectionChange">;
  /** Rewrites a just-typed newline when the platform can't intercept Enter before it lands. */
  interceptChange: (previous: string, next: string) => TextEdit | null;
  getSelection: () => TextSelection;
}
