import { describe, expect, it } from "vitest";
import type { VoiceCommandsSettings } from "@getpaseo/protocol/voice-commands/rpc-schemas";
import {
  openCustomEndpointForm,
  openKeyForm,
  openVoiceCommandsCard,
  type VoiceCommandsApi,
  type VoiceCommandsTestResult,
} from "./form";

const SETTINGS: VoiceCommandsSettings = {
  selection: null,
  backup: null,
  active: null,
  lastRoundTripMs: null,
  providers: [],
  options: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeApi(overrides: Partial<VoiceCommandsApi> = {}) {
  const calls: Array<[string, unknown]> = [];
  const api: VoiceCommandsApi = {
    setModel: async (params) => {
      calls.push(["setModel", params]);
      return SETTINGS;
    },
    setKey: async (params) => {
      calls.push(["setKey", params]);
      return SETTINGS;
    },
    test: async (target) => {
      calls.push(["test", target]);
      return { ok: true, roundTripMs: 340, error: null };
    },
    ...overrides,
  };
  return { api, calls };
}

describe("openVoiceCommandsCard", () => {
  it("saves only the picker that changed and clears the last test", async () => {
    const card = openVoiceCommandsCard();
    const { api, calls } = fakeApi();
    await card.test("selection", api);
    expect(card.getState().test).toEqual({ status: "passed", roundTripMs: 340 });
    expect(await card.choose("backup", null, api)).toBe(true);
    expect(calls.at(-1)).toEqual(["setModel", { backup: null }]);
    expect(card.getState()).toEqual({ saving: null, test: { status: "idle" }, error: null });
  });

  it("shows a failed save as one error line", async () => {
    const card = openVoiceCommandsCard();
    const { api } = fakeApi({
      setModel: async () => {
        throw new Error("Unknown model");
      },
    });
    expect(await card.choose("selection", { provider: "a", model: "b" }, api)).toBe(false);
    expect(card.getState()).toMatchObject({ saving: null, error: "Unknown model" });
  });

  it("reports a test that answered with an error", async () => {
    const card = openVoiceCommandsCard();
    const { api } = fakeApi({
      test: async () => ({ ok: false, roundTripMs: null, error: "Invalid API key (401)" }),
    });
    await card.test("backup", api);
    expect(card.getState()).toMatchObject({
      test: { status: "failed" },
      error: "Invalid API key (401)",
    });
  });

  it("reports a test that threw", async () => {
    const card = openVoiceCommandsCard();
    const { api } = fakeApi({
      test: async () => {
        throw new Error("Timed out");
      },
    });
    await card.test("selection", api);
    expect(card.getState()).toMatchObject({ test: { status: "failed" }, error: "Timed out" });
  });

  it("drops a test result that measured a model the user has since changed", async () => {
    const card = openVoiceCommandsCard();
    const pending = deferred<VoiceCommandsTestResult>();
    const { api } = fakeApi({ test: () => pending.promise });
    const running = card.test("selection", api);
    expect(card.getState().test.status).toBe("testing");
    await card.choose("selection", null, api);
    pending.resolve({ ok: false, roundTripMs: null, error: "slow" });
    await running;
    expect(card.getState()).toMatchObject({ test: { status: "idle" }, error: null });
  });
});

describe("openKeyForm", () => {
  it("saves the trimmed key and refuses an empty one", async () => {
    const form = openKeyForm();
    const saved: Array<string | null> = [];
    const save = async (apiKey: string | null) => {
      saved.push(apiKey);
    };
    expect(form.getState().canSave).toBe(false);
    expect(await form.save(save)).toBe(false);
    form.set("  sk-test  ");
    expect(form.getState().canSave).toBe(true);
    expect(await form.save(save)).toBe(true);
    expect(await form.remove(save)).toBe(true);
    expect(saved).toEqual(["sk-test", null]);
  });

  it("keeps the draft when the host rejects the key", async () => {
    const form = openKeyForm();
    form.set("sk-bad");
    const ok = await form.save(async () => {
      throw new Error("Invalid key");
    });
    expect(ok).toBe(false);
    expect(form.getState()).toMatchObject({
      draft: "sk-bad",
      submitting: null,
      error: "Invalid key",
    });
  });
});

describe("openCustomEndpointForm", () => {
  it("needs a base URL and a model id", () => {
    const form = openCustomEndpointForm({ baseUrl: "", model: "" });
    expect(form.getState().canSubmit).toBe(false);
    form.set({ baseUrl: "https://llm.example/v1" });
    expect(form.getState().canSubmit).toBe(false);
    form.set({ model: "router-7b" });
    expect(form.getState().canSubmit).toBe(true);
  });

  it("rejects a URL that is not http or https", async () => {
    const form = openCustomEndpointForm({ baseUrl: "llm.example/v1", model: "router-7b" });
    const { api, calls } = fakeApi();
    expect(await form.submit(api)).toBe(false);
    expect(form.getState().error).toEqual({ code: "invalidUrl" });
    expect(calls).toEqual([]);
  });

  it("saves the endpoint as the selection, then the key when one was typed", async () => {
    const form = openCustomEndpointForm({ baseUrl: "https://llm.example/v1", model: "old" });
    const { api, calls } = fakeApi();
    form.set({ model: " router-7b ", apiKey: " sk-local " });
    expect(await form.submit(api)).toBe(true);
    expect(calls).toEqual([
      [
        "setModel",
        {
          selection: { provider: "custom", model: "router-7b" },
          customBaseUrl: "https://llm.example/v1",
        },
      ],
      ["setKey", { provider: "custom", apiKey: "sk-local" }],
    ]);
  });

  it("leaves the stored key alone when the key field is empty", async () => {
    const form = openCustomEndpointForm({ baseUrl: "http://localhost:8000/v1", model: "local" });
    const { api, calls } = fakeApi();
    expect(await form.submit(api)).toBe(true);
    expect(calls.map(([name]) => name)).toEqual(["setModel"]);
  });
});
