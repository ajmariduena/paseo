import {
  addReplacement,
  addWords,
  removeReplacement,
  removeWord,
  updateReplacement,
  type DictionaryEdit,
  type DictionaryEditError,
  type DictionaryEntries,
  type ReplacementDraft,
} from "./catalog";

export type DictionaryFormError = DictionaryEditError | { code: "saveFailed"; message: string };
export type DictionaryErrorScope = "word" | "replacement";
export type SaveDictionary = (dictionary: DictionaryEntries) => Promise<void>;

function failure(error: unknown): DictionaryFormError {
  return { code: "saveFailed", message: error instanceof Error ? error.message : String(error) };
}

function createStore<State>(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next: State) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

interface DictionaryFormState {
  word: string;
  replacement: ReplacementDraft;
  /** Bumped after a successful add so the uncontrolled inputs clear without losing focus. */
  wordResetKey: number;
  replacementResetKey: number;
  pending: boolean;
  error: { scope: DictionaryErrorScope; error: DictionaryFormError } | null;
  canAddWord: boolean;
  canAddReplacement: boolean;
}

export function openDictionaryForm() {
  const store = createStore<DictionaryFormState>({
    word: "",
    replacement: { from: "", to: "" },
    wordResetKey: 0,
    replacementResetKey: 0,
    pending: false,
    error: null,
    canAddWord: false,
    canAddReplacement: false,
  });

  function publish(patch: Partial<DictionaryFormState>) {
    const next = { ...store.getState(), ...patch };
    store.publish({
      ...next,
      canAddWord: Boolean(next.word.trim()) && !next.pending,
      canAddReplacement:
        Boolean(next.replacement.from.trim() && next.replacement.to.trim()) && !next.pending,
    });
  }

  async function write(
    scope: DictionaryErrorScope,
    edit: DictionaryEdit,
    save: SaveDictionary,
    onSaved: Partial<DictionaryFormState>,
  ): Promise<boolean> {
    if (store.getState().pending) return false;
    if (!edit.ok) {
      publish({ error: { scope, error: edit.error } });
      return false;
    }
    publish({ pending: true, error: null });
    try {
      await save(edit.dictionary);
      publish({ ...onSaved, pending: false });
      return true;
    } catch (error) {
      publish({ pending: false, error: { scope, error: failure(error) } });
      return false;
    }
  }

  const clearError = (scope: DictionaryErrorScope) =>
    store.getState().error?.scope === scope ? null : store.getState().error;

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setWord(word: string) {
      publish({ word, error: clearError("word") });
    },
    setReplacement(patch: Partial<ReplacementDraft>) {
      publish({
        replacement: { ...store.getState().replacement, ...patch },
        error: clearError("replacement"),
      });
    },
    addWord(dictionary: DictionaryEntries, save: SaveDictionary) {
      const state = store.getState();
      return write("word", addWords(dictionary, state.word), save, {
        word: "",
        wordResetKey: state.wordResetKey + 1,
      });
    },
    addReplacement(dictionary: DictionaryEntries, save: SaveDictionary) {
      const state = store.getState();
      return write("replacement", addReplacement(dictionary, state.replacement), save, {
        replacement: { from: "", to: "" },
        replacementResetKey: state.replacementResetKey + 1,
      });
    },
    removeWord(dictionary: DictionaryEntries, word: string, save: SaveDictionary) {
      return write("word", { ok: true, dictionary: removeWord(dictionary, word) }, save, {});
    },
    removeReplacement(dictionary: DictionaryEntries, from: string, save: SaveDictionary) {
      return write(
        "replacement",
        { ok: true, dictionary: removeReplacement(dictionary, from) },
        save,
        {},
      );
    },
  };
}

interface ReplacementFormState {
  draft: ReplacementDraft;
  submitting: boolean;
  error: DictionaryFormError | null;
  canSubmit: boolean;
}

export function openReplacementForm(original: ReplacementDraft) {
  const store = createStore<ReplacementFormState>({
    draft: { from: original.from, to: original.to },
    submitting: false,
    error: null,
    canSubmit: false,
  });

  function publish(patch: Partial<ReplacementFormState>) {
    const next = { ...store.getState(), ...patch };
    const { from, to } = next.draft;
    store.publish({ ...next, canSubmit: Boolean(from.trim() && to.trim()) && !next.submitting });
  }
  publish({});

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    set(patch: Partial<ReplacementDraft>) {
      publish({ draft: { ...store.getState().draft, ...patch }, error: null });
    },
    async submit(dictionary: DictionaryEntries, save: SaveDictionary): Promise<boolean> {
      const state = store.getState();
      if (!state.canSubmit) return false;
      const edit = updateReplacement(dictionary, original.from, state.draft);
      if (!edit.ok) {
        publish({ error: edit.error });
        return false;
      }
      publish({ submitting: true, error: null });
      try {
        await save(edit.dictionary);
        publish({ submitting: false });
        return true;
      } catch (error) {
        publish({ submitting: false, error: failure(error) });
        return false;
      }
    },
  };
}
