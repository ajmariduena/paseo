import type { DictationSttOption, ServerDictationStt } from "@getpaseo/protocol/messages";

export interface DictationModelChoice {
  provider: string;
  model: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  es: "Español",
  en: "English",
  pt: "Português",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
};

export function getDictationChoiceKey(choice: DictationModelChoice): string {
  return `${choice.provider}:${choice.model}`;
}

export function findActiveDictationOption(
  selection: ServerDictationStt,
): DictationSttOption | undefined {
  return selection.options.find(
    (option) => option.provider === selection.provider && option.model === selection.model,
  );
}

export function getDictationModelLabel(
  serverInfo: { capabilities?: { dictationStt?: ServerDictationStt } } | null | undefined,
): string | null {
  const selection = serverInfo?.capabilities?.dictationStt;
  if (!selection) return null;
  return findActiveDictationOption(selection)?.label ?? (selection.model || null);
}

export function getDictationLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export function listDictationLanguages(current: string): string[] {
  const codes = Object.keys(LANGUAGE_NAMES);
  return codes.includes(current) ? codes : [current, ...codes];
}
