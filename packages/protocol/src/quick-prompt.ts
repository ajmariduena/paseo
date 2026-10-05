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
export function validateQuickPrompts(prompts: readonly QuickPrompt[]): void {
  if (new Set(prompts.map((prompt) => prompt.id)).size !== prompts.length) {
    throw new Error("Quick prompt IDs must be unique");
  }
  if (prompts.filter((prompt) => prompt.isDefault).length > 1) {
    throw new Error("Only one quick prompt can be the default");
  }
  if (prompts.filter((prompt) => prompt.pinned).length > 3) {
    throw new Error("At most three quick prompts can be pinned");
  }
  if (prompts.some((prompt) => !prompt.title.trim() || !prompt.text.trim())) {
    throw new Error("Quick prompts require a title and text");
  }
}
