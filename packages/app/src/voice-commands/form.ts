import type {
  VoiceCommandsModel,
  VoiceCommandsSettings,
} from "@getpaseo/protocol/voice-commands/rpc-schemas";
import { CUSTOM_PROVIDER, type VoiceCommandsTarget } from "./catalog";

export interface VoiceCommandsTestResult {
  ok: boolean;
  roundTripMs: number | null;
  error: string | null;
}

/** Every call resolves with the host's settings after the change, or throws a readable error. */
export interface VoiceCommandsApi {
  setModel(params: {
    selection?: VoiceCommandsModel | null;
    backup?: VoiceCommandsModel | null;
    customBaseUrl?: string;
  }): Promise<VoiceCommandsSettings>;
  setKey(params: { provider: string; apiKey: string | null }): Promise<VoiceCommandsSettings>;
  test(target: VoiceCommandsTarget): Promise<VoiceCommandsTestResult>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    publish(patch: Partial<State>) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

export type VoiceCommandsTestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "passed"; roundTripMs: number | null }
  | { status: "failed" };

interface VoiceCommandsCardState {
  /** The picker whose change is being saved. */
  saving: VoiceCommandsTarget | null;
  test: VoiceCommandsTestState;
  /** One line under the footer: the last failed save or test. */
  error: string | null;
}

export function openVoiceCommandsCard() {
  const store = createStore<VoiceCommandsCardState>({
    saving: null,
    test: { status: "idle" },
    error: null,
  });
  // A test that finishes after the model changed measured the old model.
  let generation = 0;

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    async choose(
      target: VoiceCommandsTarget,
      model: VoiceCommandsModel | null,
      api: VoiceCommandsApi,
    ): Promise<boolean> {
      if (store.getState().saving) return false;
      generation += 1;
      store.publish({ saving: target, test: { status: "idle" }, error: null });
      try {
        await api.setModel({ [target]: model });
        store.publish({ saving: null });
        return true;
      } catch (error) {
        store.publish({ saving: null, error: messageOf(error) });
        return false;
      }
    },
    /** Keys and endpoints change what answers, so an earlier measurement no longer applies. */
    reset() {
      generation += 1;
      store.publish({ test: { status: "idle" }, error: null });
    },
    async test(target: VoiceCommandsTarget, api: VoiceCommandsApi): Promise<void> {
      if (store.getState().test.status === "testing") return;
      const run = generation;
      store.publish({ test: { status: "testing" }, error: null });
      let next: Partial<VoiceCommandsCardState>;
      try {
        const result = await api.test(target);
        next = result.ok
          ? { test: { status: "passed", roundTripMs: result.roundTripMs } }
          : { test: { status: "failed" }, error: result.error };
      } catch (error) {
        next = { test: { status: "failed" }, error: messageOf(error) };
      }
      store.publish(run === generation ? next : { test: { status: "idle" } });
    },
  };
}

type SaveKey = (apiKey: string | null) => Promise<void>;

interface KeyFormState {
  draft: string;
  submitting: "save" | "remove" | null;
  error: string | null;
  canSave: boolean;
}

export function openKeyForm() {
  const store = createStore<KeyFormState>({
    draft: "",
    submitting: null,
    error: null,
    canSave: false,
  });

  function publish(patch: Partial<KeyFormState>) {
    const next = { ...store.getState(), ...patch };
    store.publish({ ...next, canSave: Boolean(next.draft.trim()) && next.submitting === null });
  }

  async function write(kind: "save" | "remove", apiKey: string | null, save: SaveKey) {
    if (store.getState().submitting) return false;
    publish({ submitting: kind, error: null });
    try {
      await save(apiKey);
      publish({ submitting: null });
      return true;
    } catch (error) {
      publish({ submitting: null, error: messageOf(error) });
      return false;
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    set(draft: string) {
      publish({ draft, error: null });
    },
    save(save: SaveKey): Promise<boolean> {
      const state = store.getState();
      if (!state.canSave) return Promise.resolve(false);
      return write("save", state.draft.trim(), save);
    },
    remove(save: SaveKey): Promise<boolean> {
      return write("remove", null, save);
    },
  };
}

export interface CustomEndpointDraft {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type CustomEndpointError = { code: "invalidUrl" } | { code: "saveFailed"; message: string };

interface CustomEndpointFormState {
  draft: CustomEndpointDraft;
  submitting: boolean;
  error: CustomEndpointError | null;
  canSubmit: boolean;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

export function openCustomEndpointForm(initial: { baseUrl: string; model: string }) {
  const store = createStore<CustomEndpointFormState>({
    draft: { baseUrl: initial.baseUrl, model: initial.model, apiKey: "" },
    submitting: false,
    error: null,
    canSubmit: false,
  });

  function publish(patch: Partial<CustomEndpointFormState>) {
    const next = { ...store.getState(), ...patch };
    const { baseUrl, model } = next.draft;
    store.publish({
      ...next,
      canSubmit: Boolean(baseUrl.trim() && model.trim()) && !next.submitting,
    });
  }
  publish({});

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    set(patch: Partial<CustomEndpointDraft>) {
      publish({ draft: { ...store.getState().draft, ...patch }, error: null });
    },
    /** Saves the endpoint and model as the selection, then the key when one was typed. */
    async submit(api: VoiceCommandsApi): Promise<boolean> {
      const state = store.getState();
      if (!state.canSubmit) return false;
      const baseUrl = state.draft.baseUrl.trim();
      const model = state.draft.model.trim();
      const apiKey = state.draft.apiKey.trim();
      if (!HTTP_URL.test(baseUrl)) {
        publish({ error: { code: "invalidUrl" } });
        return false;
      }
      publish({ submitting: true, error: null });
      try {
        await api.setModel({
          selection: { provider: CUSTOM_PROVIDER, model },
          customBaseUrl: baseUrl,
        });
        if (apiKey) await api.setKey({ provider: CUSTOM_PROVIDER, apiKey });
        publish({ submitting: false });
        return true;
      } catch (error) {
        publish({ submitting: false, error: { code: "saveFailed", message: messageOf(error) } });
        return false;
      }
    },
  };
}
