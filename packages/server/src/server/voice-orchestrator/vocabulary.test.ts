import { describe, expect, it } from "vitest";
import {
  buildVocabulary,
  correctTranscript,
  describeVocabularyForVoice,
  vocabularyKeyterms,
} from "./vocabulary.js";

describe("voice vocabulary", () => {
  const vocabulary = buildVocabulary({
    names: ["Fable 5.1", "GPT-6-Astra", "Validar las pruebas preproducción de Banco Azteca"],
    extra: ["Jeloudex"],
  });

  it("rewrites known mishearings of model names and technical words", () => {
    expect(correctTranscript("Dile que pregunte a Faybold por esto", vocabulary)).toBe(
      "Dile que pregunte a Fable por esto",
    );
    expect(correctTranscript("revisa el BorgTree, digo el work tree", vocabulary)).toBe(
      "revisa el BorgTree, digo el worktree",
    );
    expect(correctTranscript("usa kuen en serebras", vocabulary)).toBe("usa Qwen en Cerebras");
  });

  it("leaves real words alone", () => {
    const text = "despliega en Laravel Cloud y revisa el canario";
    expect(correctTranscript(text, vocabulary)).toBe(text);
  });

  it("teaches the voice model the terms, with pronunciations", () => {
    const section = describeVocabularyForVoice(vocabulary);
    expect(section).toContain('- Fable (say "FAY-bul")');
    expect(section).toContain("- Fable 5.1");
    expect(section).toContain("- Jeloudex");
  });

  it("keeps keyterms within the speech-to-text limits", () => {
    const keyterms = vocabularyKeyterms(vocabulary, 90);
    expect(keyterms.length).toBeLessThanOrEqual(90);
    expect(keyterms).toContain("Fable");
    expect(keyterms.every((term) => term.length < 50 && term.split(/\s+/).length <= 5)).toBe(true);
    expect(keyterms).not.toContain("Validar las pruebas preproducción de Banco Azteca");
  });

  it("lists each term once", () => {
    const repeated = buildVocabulary({ names: ["Fable", "fable"], extra: ["FABLE"] });
    expect(repeated.terms.filter((term) => term.term.toLowerCase() === "fable")).toHaveLength(1);
  });
});
