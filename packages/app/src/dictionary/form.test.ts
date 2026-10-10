import { describe, expect, it } from "vitest";
import type { DictionaryEntries } from "./catalog";
import { openDictionaryForm, openReplacementForm } from "./form";

const empty: DictionaryEntries = { words: [], replacements: [] };

function recorder() {
  const saved: DictionaryEntries[] = [];
  return {
    saved,
    save: async (dictionary: DictionaryEntries) => {
      saved.push(dictionary);
    },
  };
}

describe("openDictionaryForm", () => {
  it("enables Add only when the draft has text", () => {
    const form = openDictionaryForm();
    expect(form.getState().canAddWord).toBe(false);
    form.setWord("Jelou");
    expect(form.getState().canAddWord).toBe(true);
    form.setReplacement({ from: "Hello" });
    expect(form.getState().canAddReplacement).toBe(false);
    form.setReplacement({ to: "Jelou" });
    expect(form.getState().canAddReplacement).toBe(true);
  });

  it("saves the whole dictionary and clears the input after adding a word", async () => {
    const form = openDictionaryForm();
    const { saved, save } = recorder();
    form.setWord("Jelou, Supabase");
    expect(await form.addWord({ words: ["Fable"], replacements: [] }, save)).toBe(true);
    expect(saved).toEqual([{ words: ["Fable", "Jelou", "Supabase"], replacements: [] }]);
    expect(form.getState()).toMatchObject({ word: "", wordResetKey: 1, error: null });
  });

  it("keeps the draft and reports the error scoped to its card", async () => {
    const form = openDictionaryForm();
    const { saved, save } = recorder();
    form.setWord("jelou");
    expect(await form.addWord({ words: ["Jelou"], replacements: [] }, save)).toBe(false);
    expect(saved).toEqual([]);
    expect(form.getState()).toMatchObject({
      word: "jelou",
      wordResetKey: 0,
      error: { scope: "word", error: { code: "duplicateWord" } },
    });
    form.setReplacement({ from: "x" });
    expect(form.getState().error?.scope).toBe("word");
    form.setWord("Jelou2");
    expect(form.getState().error).toBeNull();
  });

  it("surfaces a failed save and leaves the input untouched", async () => {
    const form = openDictionaryForm();
    form.setReplacement({ from: "Hello", to: "Jelou" });
    const ok = await form.addReplacement(empty, async () => {
      throw new Error("Host went away");
    });
    expect(ok).toBe(false);
    expect(form.getState()).toMatchObject({
      replacement: { from: "Hello", to: "Jelou" },
      replacementResetKey: 0,
      pending: false,
      error: { scope: "replacement", error: { code: "saveFailed", message: "Host went away" } },
    });
  });

  it("ignores a second write while one is in flight", async () => {
    const form = openDictionaryForm();
    let release = () => {};
    const slow = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const first = form.removeWord({ words: ["Jelou", "Fable"], replacements: [] }, "Jelou", slow);
    expect(form.getState().pending).toBe(true);
    expect(await form.removeWord(empty, "Fable", recorder().save)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(form.getState().pending).toBe(false);
  });
});

describe("openReplacementForm", () => {
  it("seeds from the replacement being edited and saves it in place", async () => {
    const dictionary: DictionaryEntries = {
      words: [],
      replacements: [
        { from: "Hello", to: "Jelou" },
        { from: "Faybold", to: "Fable" },
      ],
    };
    const form = openReplacementForm({ from: "Hello", to: "Jelou" });
    expect(form.getState()).toMatchObject({
      draft: { from: "Hello", to: "Jelou" },
      canSubmit: true,
    });
    form.set({ to: "Jelou Inc" });
    const { saved, save } = recorder();
    expect(await form.submit(dictionary, save)).toBe(true);
    expect(saved[0]?.replacements).toEqual([
      { from: "Hello", to: "Jelou Inc" },
      { from: "Faybold", to: "Fable" },
    ]);
  });

  it("blocks a heard phrase that another replacement already uses", async () => {
    const dictionary: DictionaryEntries = {
      words: [],
      replacements: [
        { from: "Hello", to: "Jelou" },
        { from: "Faybold", to: "Fable" },
      ],
    };
    const form = openReplacementForm({ from: "Hello", to: "Jelou" });
    form.set({ from: "FAYBOLD" });
    expect(await form.submit(dictionary, recorder().save)).toBe(false);
    expect(form.getState().error).toEqual({ code: "duplicateHeard" });
    form.set({ to: "" });
    expect(form.getState()).toMatchObject({ error: null, canSubmit: false });
  });
});
