import type { Dictionary } from "@getpaseo/protocol/messages";
import { replacePhrase } from "../speech/dictionary.js";

/**
 * Names and technical words a voice call hears often. Speech recognition trained on everyday
 * speech mishears them, especially English words said in Spanish ("Fable" comes out as
 * "Faybold"), so each term lists what it tends to be heard as and, when it helps, how to say it.
 */
export interface VocabularyTerm {
  term: string;
  /** How a transcript tends to spell it when it gets it wrong. */
  heardAs?: string[];
  /** A pronunciation hint for the voice model. */
  say?: string;
}

export const DEFAULT_VOCABULARY: VocabularyTerm[] = [
  { term: "Paseo" },
  {
    term: "Fable",
    heardAs: ["faybold", "feibold", "feibol", "faybol", "feible", "fabel", "feibel", "fable's"],
    say: "FAY-bul",
  },
  { term: "Opus", heardAs: ["opas", "opos", "ópus"] },
  { term: "Sonnet", heardAs: ["sonet", "soneth"] },
  { term: "Haiku", heardAs: ["jaiku", "haikú", "jaikú"] },
  { term: "Claude", heardAs: ["clod", "claud", "clode"], say: "klawd" },
  { term: "Claude Code", heardAs: ["cloud code", "clod code", "claud code"] },
  { term: "Codex", heardAs: ["códex", "kodex"] },
  { term: "Astra", heardAs: ["ástra"] },
  { term: "Sol" },
  { term: "Luna" },
  { term: "GPT", heardAs: ["yi pi ti", "ge pe te", "gepeté"], say: "G P T" },
  { term: "GPT-Live", heardAs: ["gpt laif", "gpt life"] },
  { term: "Qwen", heardAs: ["kuen", "quen", "kwen", "güen", "cuen"], say: "chwen" },
  { term: "Cerebras", heardAs: ["serebras", "cerebra", "célebras"] },
  { term: "Gemini", heardAs: ["yemini", "jemini"] },
  { term: "Grok", heardAs: ["grock", "groc"] },
  { term: "GLM", heardAs: ["ge ele eme"] },
  { term: "OpenCode", heardAs: ["opencod"] },
  { term: "Copilot", heardAs: ["copailot"] },
  { term: "Cursor" },
  { term: "Anthropic", heardAs: ["antropic", "antrópic"] },
  { term: "OpenAI", heardAs: ["open eye", "openei"] },
  { term: "worktree", heardAs: ["work tree", "guorktri", "worktri", "work three"] },
  { term: "workspace", heardAs: ["work space", "guorkspeis", "workspeis"] },
  { term: "PR", heardAs: ["pi ar", "pe erre"], say: "P R" },
  { term: "pull request", heardAs: ["pul request", "pool request"] },
  { term: "merge", heardAs: ["merch", "mersh"] },
  { term: "rebase", heardAs: ["ribeis", "rebeis"] },
  { term: "commit", heardAs: ["comit"] },
  { term: "push", heardAs: ["puch"] },
  { term: "deploy", heardAs: ["diploy"] },
  { term: "canary", heardAs: ["canari", "kanari"] },
  { term: "TestFlight", heardAs: ["test flight", "testflait", "test fly"] },
  { term: "daemon", heardAs: ["demon", "dimon", "démon"], say: "DEE-mun" },
  { term: "host" },
  { term: "branch", heardAs: ["brench"] },
  { term: "CI", heardAs: ["si ai"] },
  { term: "typecheck", heardAs: ["type check", "taipchek"] },
  { term: "lint" },
  { term: "Playwright", heardAs: ["play right", "pleirait"] },
  { term: "Expo" },
  { term: "React Native", heardAs: ["riact native", "react neitiv"] },
  { term: "TypeScript", heardAs: ["taipscript", "type script"] },
  { term: "npm", heardAs: ["en pe eme", "n p m"] },
  { term: "Docker", heardAs: ["doker", "dóquer"] },
  { term: "Slack", heardAs: ["eslac", "slac"] },
  { term: "GitHub", heardAs: ["guithub", "gitjab"] },
  { term: "token" },
  { term: "prompt", heardAs: ["promt"] },
  { term: "VPS", heardAs: ["bps", "be pe ese", "v p s", "vé pe ese"] },
];

export interface Vocabulary {
  terms: VocabularyTerm[];
}

/**
 * The call's vocabulary: the defaults, the user's dictionary and the host's own names (models,
 * providers, projects, workspaces, agents, hosts).
 */
export function buildVocabulary(params: {
  names: readonly string[];
  dictionary?: Dictionary;
}): Vocabulary {
  const byKey = new Map<string, VocabularyTerm>();
  const add = (term: VocabularyTerm) => {
    const name = term.term.trim();
    const key = name.toLowerCase();
    if (!key || key.length > 48) return;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...term, term: name });
      return;
    }
    if (term.heardAs?.length) {
      existing.heardAs = [...(existing.heardAs ?? []), ...term.heardAs];
    }
  };
  for (const term of DEFAULT_VOCABULARY) add(term);
  for (const word of params.dictionary?.words ?? []) add({ term: word });
  for (const { from, to } of params.dictionary?.replacements ?? []) {
    add({ term: to, heardAs: [from] });
  }
  for (const name of params.names) add({ term: name });
  return { terms: Array.from(byKey.values()) };
}

/** Rewrites known mishearings to the term ("dile a Faybold" → "dile a Fable"). */
export function correctTranscript(text: string, vocabulary: Vocabulary): string {
  let result = text;
  for (const term of vocabulary.terms) {
    for (const heard of term.heardAs ?? []) {
      if (heard.toLowerCase() === term.term.toLowerCase()) continue;
      result = replacePhrase(result, heard, term.term);
    }
  }
  return result;
}

/** The section of the voice model's instructions that teaches it these words. */
export function describeVocabularyForVoice(vocabulary: Vocabulary, limit = 160): string {
  const lines = vocabulary.terms.slice(0, limit).map((term) => {
    const say = term.say ? ` (say "${term.say}")` : "";
    const heard = term.heardAs?.length
      ? ` — may sound like ${term.heardAs.slice(0, 3).join(", ")}`
      : "";
    return `- ${term.term}${say}${heard}`;
  });
  return [
    "Vocabulary: the user talks about software and AI models, often mixing English words into Spanish. Recognize these names and terms even when said with an accent, and always say them as written:",
    ...lines,
  ].join("\n");
}

/** Terms for a speech-to-text keyterm list, within the provider's limits. */
export function vocabularyKeyterms(vocabulary: Vocabulary, limit: number): string[] {
  return vocabulary.terms
    .map((term) => term.term.replace(/[<>{}[\]\\]/g, "").trim())
    .filter((term) => term.length > 1 && term.length < 50 && term.split(/\s+/).length <= 5)
    .slice(0, limit);
}
