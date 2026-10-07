import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MenuSeparator, MenuSubTrigger, type MenuPageDefinition } from "@/components/ui/menu";
import { QuickPromptPickerList, type QuickPromptPicker } from "./picker";

export const QUICK_PROMPT_MENU_PAGE_ID = "quick-prompts";

/** The attachment menu's way into quick prompts, for layouts whose toolbar has no slot for them. */
export function QuickPromptMenuTrigger({ picker }: { picker: QuickPromptPicker }): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <MenuSeparator />
      <MenuSubTrigger
        id={QUICK_PROMPT_MENU_PAGE_ID}
        value={picker.shortcutPrompt?.title}
        testID="quick-prompts-menu-trigger"
      >
        {t("quickPrompts.section")}
      </MenuSubTrigger>
    </>
  );
}

export function buildQuickPromptMenuPage(
  picker: QuickPromptPicker,
  title: string,
): MenuPageDefinition {
  return {
    id: QUICK_PROMPT_MENU_PAGE_ID,
    title,
    content: <QuickPromptPickerList picker={picker} />,
  };
}
