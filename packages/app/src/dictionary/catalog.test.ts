import { describe, expect, it } from "vitest";
import { DICTIONARY_LIMITS, validateDictionary } from "@getpaseo/protocol/messages";
import {
  addReplacement,
  addWords,
  normalizeDictionary,
  removeReplacement,
  removeWord,
  splitWords,
  updateReplacement,
  type DictionaryEntries,
} from "./catalog";

function entries(partial: Partial<DictionaryEntries> = {}): DictionaryEntries {
  return { words: [], replacements: [], ...partial };
}

describe("normalizeDictionary", () => {
  it("returns empty lists for a host that has no dictionary", () => {
    expect(normalizeDictionary(undefined)).toEqual({ words: [], replacements: [] });
  });

  it("trims, drops empties, and dedupes words and heard phrases case-insensitively", () => {
    const normalized = normalizeDictionary({
      words: [" Jelou ", "", "jelou", "Supabase"],
      replacements: [
        { from: " Hello ", to: " Jelou " },
        { from: "hello", to: "Other" },
        { from: "Faybold", to: "  " },
      ],
    });
    expect(normalized.words).toEqual(["Jelou", "Supabase"]);
    expect(normalized.replacements).toEqual([{ from: "Hello", to: "Jelou" }]);
  });

  it("keeps fields a newer daemon sends so a save does not drop them", () => {
    const normalized = normalizeDictionary({
      words: ["Jelou"],
      enabled: true,
    } as Parameters<typeof normalizeDictionary>[0]);
    expect(normalized).toMatchObject({ enabled: true, words: ["Jelou"] });
  });
});

describe("words", () => {
  it("splits pasted lists on commas, semicolons, and new lines", () => {
    expect(splitWords("Kubernetes, Supabase;\nVisual Studio Code ,")).toEqual([
      "Kubernetes",
      "Supabase",
      "Visual Studio Code",
    ]);
  });

  it("appends new words and skips ones already present", () => {
    const result = addWords(entries({ words: ["Jelou"] }), "jelou, Supabase, supabase");
    expect(result).toEqual({ ok: true, dictionary: entries({ words: ["Jelou", "Supabase"] }) });
  });

  it("rejects empty input, duplicates, long entries, and going over the limit", () => {
    expect(addWords(entries(), " , ")).toEqual({ ok: false, error: { code: "emptyWord" } });
    expect(addWords(entries({ words: ["Jelou"] }), "JELOU")).toEqual({
      ok: false,
      error: { code: "duplicateWord" },
    });
    expect(addWords(entries(), "x".repeat(DICTIONARY_LIMITS.termLength + 1))).toEqual({
      ok: false,
      error: { code: "tooLong", max: DICTIONARY_LIMITS.termLength },
    });
    const full = entries({
      words: Array.from({ length: DICTIONARY_LIMITS.words }, (_, index) => `word${index}`),
    });
    expect(addWords(full, "Jelou")).toEqual({
      ok: false,
      error: { code: "wordLimit", max: DICTIONARY_LIMITS.words },
    });
  });

  it("removes a word", () => {
    expect(removeWord(entries({ words: ["Jelou", "Supabase"] }), "Jelou").words).toEqual([
      "Supabase",
    ]);
  });
});

describe("replacements", () => {
  const base = entries({
    replacements: [
      { from: "Hello", to: "Jelou" },
      { from: "Faybold", to: "Fable" },
    ],
  });

  it("adds a trimmed replacement that the protocol accepts", () => {
    const result = addReplacement(base, { from: " super base ", to: " Supabase " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dictionary.replacements.at(-1)).toEqual({ from: "super base", to: "Supabase" });
    expect(() => validateDictionary(result.dictionary)).not.toThrow();
  });

  it("allows one replacement per heard phrase", () => {
    expect(addReplacement(base, { from: "hello", to: "Hola" })).toEqual({
      ok: false,
      error: { code: "duplicateHeard" },
    });
  });

  it("requires both sides and enforces the limits", () => {
    expect(addReplacement(base, { from: "Hello", to: " " })).toEqual({
      ok: false,
      error: { code: "emptyReplacement" },
    });
    const full = entries({
      replacements: Array.from({ length: DICTIONARY_LIMITS.replacements }, (_, index) => ({
        from: `heard${index}`,
        to: `written${index}`,
      })),
    });
    expect(addReplacement(full, { from: "Hello", to: "Jelou" })).toEqual({
      ok: false,
      error: { code: "replacementLimit", max: DICTIONARY_LIMITS.replacements },
    });
  });

  it("edits in place, including changing the heard phrase or only its casing", () => {
    const renamed = updateReplacement(base, "Hello", { from: "Yellow", to: "Jelou" });
    expect(renamed.ok && renamed.dictionary.replacements).toEqual([
      { from: "Yellow", to: "Jelou" },
      { from: "Faybold", to: "Fable" },
    ]);
    const recased = updateReplacement(base, "Hello", { from: "hello", to: "Jelou" });
    expect(recased.ok).toBe(true);
    expect(updateReplacement(base, "Hello", { from: "faybold", to: "Jelou" })).toEqual({
      ok: false,
      error: { code: "duplicateHeard" },
    });
  });

  it("adds the edit back when the original was removed meanwhile", () => {
    const result = updateReplacement(base, "Gone", { from: "Gone", to: "Here" });
    expect(result.ok && result.dictionary.replacements.at(-1)).toEqual({
      from: "Gone",
      to: "Here",
    });
  });

  it("removes a replacement by its heard phrase", () => {
    expect(removeReplacement(base, "hello").replacements).toEqual([
      { from: "Faybold", to: "Fable" },
    ]);
  });
});
