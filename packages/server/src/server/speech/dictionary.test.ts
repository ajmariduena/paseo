import { describe, expect, it } from "vitest";
import {
  applyDictionaryReplacements,
  describeDictionaryForPrompt,
  normalizeDictionary,
  realtimeKeyterms,
} from "./dictionary.js";

describe("dictionary", () => {
  const dictionary = {
    words: ["Zentrix", "Kubernetes operator rollout plan"],
    replacements: [
      { from: "Hello", to: "Jelou" },
      { from: "work tree", to: "worktree" },
    ],
  };

  it("rewrites whole words regardless of case", () => {
    expect(applyDictionaryReplacements("hello, abre el work  tree de HELLO", dictionary)).toBe(
      "Jelou, abre el worktree de Jelou",
    );
  });

  it("leaves words that only contain the phrase", () => {
    expect(applyDictionaryReplacements("Othello y helloworld", dictionary)).toBe(
      "Othello y helloworld",
    );
  });

  it("does nothing without a dictionary", () => {
    expect(applyDictionaryReplacements("hello", undefined)).toBe("hello");
    expect(describeDictionaryForPrompt(undefined)).toBe("");
  });

  it("listens for words and what replacements write, within realtime limits", () => {
    expect(realtimeKeyterms(dictionary)).toEqual(["Zentrix", "Jelou", "worktree"]);
  });

  it("names the vocabulary for prompt-driven recognizers", () => {
    expect(describeDictionaryForPrompt(dictionary)).toBe(
      "Vocabulary that may appear: Zentrix, Kubernetes operator rollout plan, Jelou, worktree.",
    );
  });

  it("repairs hand-edited entries instead of failing", () => {
    expect(
      normalizeDictionary({
        words: [" Zentrix ", "zentrix", "", "x".repeat(49)],
        replacements: [
          { from: "Hello ", to: " Jelou" },
          { from: "hello", to: "Hola" },
          { from: "", to: "nada" },
        ],
      }),
    ).toEqual({ words: ["Zentrix"], replacements: [{ from: "Hello", to: "Jelou" }] });
  });
});
