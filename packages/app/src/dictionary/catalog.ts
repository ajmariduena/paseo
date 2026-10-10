import {
  DICTIONARY_LIMITS,
  type Dictionary,
  type DictionaryReplacement,
} from "@getpaseo/protocol/messages";

export type DictionaryEntries = Dictionary & {
  words: string[];
  replacements: DictionaryReplacement[];
};

export interface ReplacementDraft {
  from: string;
  to: string;
}

export type DictionaryEditError =
  | { code: "emptyWord" }
  | { code: "emptyReplacement" }
  | { code: "tooLong"; max: number }
  | { code: "duplicateWord" }
  | { code: "duplicateHeard" }
  | { code: "wordLimit"; max: number }
  | { code: "replacementLimit"; max: number };

export type DictionaryEdit =
  | { ok: true; dictionary: DictionaryEntries }
  | { ok: false; error: DictionaryEditError };

const fold = (term: string) => term.trim().toLowerCase();
const tooLong = (term: string) => term.length > DICTIONARY_LIMITS.termLength;
const TOO_LONG: DictionaryEditError = { code: "tooLong", max: DICTIONARY_LIMITS.termLength };

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function normalizeDictionary(dictionary: Dictionary | undefined): DictionaryEntries {
  const words = uniqueBy(
    (dictionary?.words ?? []).map((word) => word.trim()).filter(Boolean),
    fold,
  );
  const replacements: DictionaryReplacement[] = [];
  const heard = new Set<string>();
  for (const entry of dictionary?.replacements ?? []) {
    const from = entry.from.trim();
    const to = entry.to.trim();
    if (!from || !to || heard.has(fold(from))) continue;
    heard.add(fold(from));
    replacements.push({ ...entry, from, to });
  }
  return { ...dictionary, words, replacements };
}

export function splitWords(input: string): string[] {
  return input
    .split(/[,;\n]/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function addWords(dictionary: DictionaryEntries, input: string): DictionaryEdit {
  const terms = splitWords(input);
  if (terms.length === 0) return { ok: false, error: { code: "emptyWord" } };
  if (terms.some(tooLong)) return { ok: false, error: TOO_LONG };
  const known = new Set(dictionary.words.map(fold));
  const fresh = uniqueBy(terms, fold).filter((term) => !known.has(fold(term)));
  if (fresh.length === 0) return { ok: false, error: { code: "duplicateWord" } };
  if (dictionary.words.length + fresh.length > DICTIONARY_LIMITS.words) {
    return { ok: false, error: { code: "wordLimit", max: DICTIONARY_LIMITS.words } };
  }
  return { ok: true, dictionary: { ...dictionary, words: [...dictionary.words, ...fresh] } };
}

export function removeWord(dictionary: DictionaryEntries, word: string): DictionaryEntries {
  return { ...dictionary, words: dictionary.words.filter((entry) => entry !== word) };
}

function checkReplacement(
  dictionary: DictionaryEntries,
  draft: ReplacementDraft,
  original: string | null,
): { ok: false; error: DictionaryEditError } | { ok: true; entry: DictionaryReplacement } {
  const from = draft.from.trim();
  const to = draft.to.trim();
  if (!from || !to) return { ok: false, error: { code: "emptyReplacement" } };
  if (tooLong(from) || tooLong(to)) return { ok: false, error: TOO_LONG };
  const others = dictionary.replacements.filter(
    (entry) => original === null || fold(entry.from) !== fold(original),
  );
  if (others.some((entry) => fold(entry.from) === fold(from))) {
    return { ok: false, error: { code: "duplicateHeard" } };
  }
  if (others.length >= DICTIONARY_LIMITS.replacements) {
    return { ok: false, error: { code: "replacementLimit", max: DICTIONARY_LIMITS.replacements } };
  }
  return { ok: true, entry: { from, to } };
}

export function addReplacement(
  dictionary: DictionaryEntries,
  draft: ReplacementDraft,
): DictionaryEdit {
  const checked = checkReplacement(dictionary, draft, null);
  if (!checked.ok) return checked;
  return {
    ok: true,
    dictionary: { ...dictionary, replacements: [...dictionary.replacements, checked.entry] },
  };
}

/** Keeps the entry's position; an entry deleted meanwhile is added back at the end. */
export function updateReplacement(
  dictionary: DictionaryEntries,
  original: string,
  draft: ReplacementDraft,
): DictionaryEdit {
  const checked = checkReplacement(dictionary, draft, original);
  if (!checked.ok) return checked;
  const index = dictionary.replacements.findIndex((entry) => fold(entry.from) === fold(original));
  const replacements =
    index === -1
      ? [...dictionary.replacements, checked.entry]
      : dictionary.replacements.map((entry, at) =>
          at === index ? { ...entry, ...checked.entry } : entry,
        );
  return { ok: true, dictionary: { ...dictionary, replacements } };
}

export function removeReplacement(dictionary: DictionaryEntries, from: string): DictionaryEntries {
  return {
    ...dictionary,
    replacements: dictionary.replacements.filter((entry) => fold(entry.from) !== fold(from)),
  };
}
