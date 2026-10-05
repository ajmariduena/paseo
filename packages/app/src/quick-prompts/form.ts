import type { QuickPrompt } from "@getpaseo/protocol/messages";

export function openQuickPromptForm(prompt: QuickPrompt, pinCount: number) {
  let state = { prompt, submitting: false, error: "", canSubmit: false };
  const listeners = new Set<() => void>();
  function publish() {
    const { title, text, pinned } = state.prompt;
    const tooManyPins = pinned && !prompt.pinned && pinCount >= 3;
    state = {
      ...state,
      canSubmit: Boolean(
        title.trim() &&
        title.length <= 80 &&
        text.trim() &&
        text.length <= 100000 &&
        !tooManyPins &&
        !state.submitting,
      ),
    };
    for (const listener of listeners) listener();
  }
  publish();
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(patch: Partial<QuickPrompt>) {
      state = { ...state, prompt: { ...state.prompt, ...patch } };
      publish();
    },
    async submit(save: (prompt: QuickPrompt) => Promise<void>): Promise<boolean> {
      if (!state.canSubmit) return false;
      state = { ...state, submitting: true, error: "" };
      publish();
      try {
        await save({
          ...state.prompt,
          title: state.prompt.title.trim(),
          text: state.prompt.text.trim(),
        });
        return true;
      } catch (error) {
        state = { ...state, error: error instanceof Error ? error.message : String(error) };
        return false;
      } finally {
        state = { ...state, submitting: false };
        publish();
      }
    },
  };
}

export function newQuickPrompt(text = ""): QuickPrompt {
  return {
    id: `quick_prompt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    title: text.trim().split(/\s+/).slice(0, 4).join(" ").slice(0, 80),
    text,
    mode: "send",
    pinned: false,
    isDefault: false,
  };
}
