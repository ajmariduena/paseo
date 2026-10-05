import type { QuickPrompt } from "@getpaseo/protocol/messages";

export type QuickPromptPickerAction = "send" | "insert" | "pin" | "default";

export function updateQuickPrompt(
  prompts: readonly QuickPrompt[],
  prompt: QuickPrompt,
): QuickPrompt[] {
  const exists = prompts.some((entry) => entry.id === prompt.id);
  const next = exists
    ? prompts.map((entry) => (entry.id === prompt.id ? prompt : entry))
    : [...prompts, prompt];
  return next.map((entry) => {
    if (!prompt.isDefault || entry.id === prompt.id || !entry.isDefault) return entry;
    return Object.assign({}, entry, { isDefault: false });
  });
}

export function moveQuickPrompt(
  prompts: readonly QuickPrompt[],
  id: string,
  offset: -1 | 1,
): QuickPrompt[] {
  const next = [...prompts];
  const index = next.findIndex((prompt) => prompt.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= next.length) return next;
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry);
  return next;
}

export interface QuickPromptPickerPorts {
  send: (prompt: QuickPrompt) => void;
  insert: (text: string) => void;
  save: (prompts: QuickPrompt[]) => Promise<void>;
}

export async function selectQuickPrompt(input: {
  action: QuickPromptPickerAction;
  prompt: QuickPrompt;
  prompts: readonly QuickPrompt[];
  ports: QuickPromptPickerPorts;
}): Promise<void> {
  const { action, prompt, prompts, ports } = input;
  if (action === "send") {
    ports.send(prompt);
    return;
  }
  if (action === "insert") {
    ports.insert(prompt.text);
    return;
  }
  if (action === "pin" && !prompt.pinned && prompts.filter((entry) => entry.pinned).length >= 3)
    return;
  const next = { ...prompt };
  if (action === "pin") next.pinned = !prompt.pinned;
  if (action === "default") next.isDefault = !prompt.isDefault;
  await ports.save(updateQuickPrompt(prompts, next));
}

export function isQuickPromptActionDisabled(
  mode: QuickPrompt["mode"],
  writing: boolean,
  sending: boolean,
): boolean {
  return writing || (mode === "send" && sending);
}
