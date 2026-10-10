import { DICTIONARY_LIMITS, type Dictionary } from "@getpaseo/protocol/messages";

/** ElevenLabs Scribe Realtime accepts at most 50 keyterms of up to 20 characters each. */
const REALTIME_KEYTERM_LIMIT = 50;
const REALTIME_KEYTERM_LENGTH = 20;

/** Rewrites every whole-word, case-insensitive occurrence of `from` with `to`. */
export function replacePhrase(text: string, from: string, to: string): string {
  const words = from.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return text;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words.join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");
  return text.replace(pattern, () => to);
}

/** Applies the user's replacements ("Hello" → "Jelou") to a transcript. */
export function applyDictionaryReplacements(
  text: string,
  dictionary: Dictionary | undefined,
): string {
  let result = text;
  for (const { from, to } of dictionary?.replacements ?? []) {
    result = replacePhrase(result, from, to.trim());
  }
  return result;
}

/** The words a recognizer should listen for: the user's words and what replacements write. */
export function dictionaryTerms(dictionary: Dictionary | undefined): string[] {
  const sources = [
    ...(dictionary?.words ?? []),
    ...(dictionary?.replacements ?? []).map((entry) => entry.to),
  ];
  return uniqueBy(sources.map((source) => source.trim()).filter(Boolean), (term) =>
    term.toLowerCase(),
  );
}

export function realtimeKeyterms(dictionary: Dictionary | undefined): string[] {
  return dictionaryTerms(dictionary)
    .filter((term) => term.length <= REALTIME_KEYTERM_LENGTH && !/[<>{}[\]\\]/.test(term))
    .slice(0, REALTIME_KEYTERM_LIMIT);
}

/** A hint for prompt-driven recognizers, which have no keyterm list. */
export function describeDictionaryForPrompt(dictionary: Dictionary | undefined): string {
  const terms = dictionaryTerms(dictionary).slice(0, 100);
  return terms.length > 0 ? `Vocabulary that may appear: ${terms.join(", ")}.` : "";
}

/** Hand-edited config must not stop the daemon; writes through the API stay strict. */
export function normalizeDictionary(dictionary: Dictionary | undefined): Dictionary | undefined {
  if (!dictionary) return dictionary;
  const fits = (value: string) => {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= DICTIONARY_LIMITS.termLength;
  };
  const words = uniqueBy(
    (dictionary.words ?? []).filter(fits).map((word) => word.trim()),
    (word) => word.toLowerCase(),
  ).slice(0, DICTIONARY_LIMITS.words);
  const replacements = uniqueBy(
    (dictionary.replacements ?? [])
      .filter((entry) => fits(entry.from) && fits(entry.to))
      .map((entry) => ({ from: entry.from.trim(), to: entry.to.trim() })),
    (entry) => entry.from.toLowerCase(),
  ).slice(0, DICTIONARY_LIMITS.replacements);
  return { words, replacements };
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
