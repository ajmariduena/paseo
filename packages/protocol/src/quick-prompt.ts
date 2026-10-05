import { z } from "zod";

export const QuickPromptSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(80),
  text: z.string().min(1).max(100000),
  mode: z.enum(["send", "insert"]),
  pinned: z.boolean(),
  isDefault: z.boolean(),
});
export type QuickPrompt = z.infer<typeof QuickPromptSchema>;

// Cross-record invariants belong at the write boundary, not in generated wire validators.
const validationMessages = {
  duplicateIds: "Quick prompt IDs must be unique",
  multipleDefaults: "Only one quick prompt can be the default",
  pinLimit: "At most three quick prompts can be pinned",
  required: "Quick prompts require a title and text",
};
export function validateQuickPrompts(
  prompts: readonly QuickPrompt[],
  messages: typeof validationMessages = validationMessages,
): void {
  if (new Set(prompts.map((prompt) => prompt.id)).size !== prompts.length) {
    throw new Error(messages.duplicateIds);
  }
  if (prompts.filter((prompt) => prompt.isDefault).length > 1) {
    throw new Error(messages.multipleDefaults);
  }
  if (prompts.filter((prompt) => prompt.pinned).length > 3) {
    throw new Error(messages.pinLimit);
  }
  if (prompts.some((prompt) => !prompt.title.trim() || !prompt.text.trim())) {
    throw new Error(messages.required);
  }
}
