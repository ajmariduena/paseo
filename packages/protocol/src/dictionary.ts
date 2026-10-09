import { z } from "zod";

export const DictionaryReplacementSchema = z
  .object({
    from: z.string(),
    to: z.string(),
  })
  .passthrough();
export type DictionaryReplacement = z.infer<typeof DictionaryReplacementSchema>;

export const DictionarySchema = z
  .object({
    words: z.array(z.string()).optional(),
    replacements: z.array(DictionaryReplacementSchema).optional(),
  })
  .passthrough();
export type Dictionary = z.infer<typeof DictionarySchema>;

export const DICTIONARY_LIMITS = {
  words: 400,
  replacements: 200,
  termLength: 48,
} as const;

// Limits are checked at the write boundary so a client never fails to parse a daemon's dictionary.
export function validateDictionary(dictionary: Dictionary): void {
  const words = dictionary.words ?? [];
  const replacements = dictionary.replacements ?? [];
  if (words.length > DICTIONARY_LIMITS.words) {
    throw new Error(`The dictionary holds at most ${DICTIONARY_LIMITS.words} words`);
  }
  if (replacements.length > DICTIONARY_LIMITS.replacements) {
    throw new Error(`The dictionary holds at most ${DICTIONARY_LIMITS.replacements} replacements`);
  }
  const terms = [...words, ...replacements.flatMap((entry) => [entry.from, entry.to])];
  if (terms.some((term) => !term.trim())) {
    throw new Error("Dictionary entries can't be empty");
  }
  if (terms.some((term) => term.trim().length > DICTIONARY_LIMITS.termLength)) {
    throw new Error(`Dictionary entries are at most ${DICTIONARY_LIMITS.termLength} characters`);
  }
  const froms = replacements.map((entry) => entry.from.trim().toLowerCase());
  if (new Set(froms).size !== froms.length) {
    throw new Error("Each heard phrase can have only one replacement");
  }
}
