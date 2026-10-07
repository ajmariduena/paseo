import type { QuickPrompt } from "@getpaseo/protocol/messages";
import {
  createDeferredQuickPromptSend,
  type QuickPromptContext,
  type QuickPromptCapture,
} from "@/quick-prompts/deferred-send";
import {
  isQuickPromptActionDisabled,
  selectQuickPrompt,
  moveQuickPrompt,
  resolveQuickPromptShortcut,
  updateQuickPrompt,
} from "@/quick-prompts/catalog";
import { openQuickPromptForm } from "@/quick-prompts/form";
import { describe, expect, it } from "vitest";
import {
  applyDictationTranscript,
  computeCanStartDictation,
  resolveActiveSendBehavior,
  resolveAlternateSendActions,
  resolveComposerSurfacePresentation,
  runAlternateSendAction,
  runDefaultSendAction,
  runMessageInputKeyboardAction,
} from "./state";

const connected = { isConnected: true } as never;
const disconnected = { isConnected: false } as never;

function createDictationKeyboard({ startsRecording }: { startsRecording: boolean }) {
  let isRecording = false;
  const actions: string[] = [];

  return {
    actions,
    pressDictationShortcut: () =>
      runMessageInputKeyboardAction("dictation-toggle", {
        focusInput: () => undefined,
        isDictationRecording: () => isRecording,
        markTranscriptForSend: () => actions.push("send transcript"),
        startDictation: () => {
          actions.push("start");
          isRecording = startsRecording;
        },
        confirmDictation: () => {
          actions.push("confirm");
          isRecording = false;
        },
        cancelDictation: () => undefined,
      }),
  };
}

describe("composer surface presentation", () => {
  it("shows only the input when no voice overlay is active", () => {
    expect(resolveComposerSurfacePresentation(false)).toEqual({
      input: { opacity: 1, pointerEvents: "auto" },
      overlay: { opacity: 0, pointerEvents: "none" },
    });
  });

  it("shows only the voice overlay while voice UI is active", () => {
    expect(resolveComposerSurfacePresentation(true)).toEqual({
      input: { opacity: 0, pointerEvents: "none" },
      overlay: { opacity: 1, pointerEvents: "auto" },
    });
  });
});

describe("computeCanStartDictation", () => {
  it("returns false when socket is disconnected", () => {
    expect(
      computeCanStartDictation({
        client: disconnected,
        isReadyForDictation: true,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });

  it("returns false when isReadyForDictation is explicitly false", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: false,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });

  it("returns true when connected and ready", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: true,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(true);
  });

  it("falls back to socket connected state when isReadyForDictation is undefined", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: undefined,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(true);

    expect(
      computeCanStartDictation({
        client: disconnected,
        isReadyForDictation: undefined,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });

  it("returns false when the input is disabled", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: true,
        disabled: true,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });

  it("returns false when a dictation unavailable message is present", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: true,
        disabled: false,
        dictationUnavailableMessage: "Microphone unavailable",
      }),
    ).toBe(false);
  });

  it("returns false when client is null", () => {
    expect(
      computeCanStartDictation({
        client: null,
        isReadyForDictation: true,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });
});

describe("dictation keyboard behavior", () => {
  it("starts dictation again after the previous dictation finishes", () => {
    const keyboard = createDictationKeyboard({ startsRecording: true });

    keyboard.pressDictationShortcut();
    keyboard.pressDictationShortcut();
    keyboard.pressDictationShortcut();

    expect(keyboard.actions).toEqual(["start", "send transcript", "confirm", "start"]);
  });

  it("can retry when starting dictation does not enter the recording state", () => {
    const keyboard = createDictationKeyboard({ startsRecording: false });

    keyboard.pressDictationShortcut();
    keyboard.pressDictationShortcut();

    expect(keyboard.actions).toEqual(["start", "start"]);
  });
});

describe("dictation transcript behavior", () => {
  it("publishes an auto-sent transcript to the composer before submitting it", () => {
    const actions: string[] = [];

    applyDictationTranscript("spoken prompt", {
      value: "typed context",
      defaultSendBehavior: "interrupt",
      isAgentRunning: false,
      onQueue: undefined,
      replaceText: (text) => actions.push(`replace:${text}`),
      onSubmit: (payload) => actions.push(`submit:${payload.text}`),
      attachments: [],
      cwd: "/repo",
      autoSend: true,
    });

    expect(actions).toEqual([
      "replace:typed context spoken prompt",
      "submit:typed context spoken prompt",
    ]);
  });
});

describe("composer send behavior", () => {
  it("sends immediately when queue mode cannot advance past a permission", () => {
    expect(resolveActiveSendBehavior("queue", true)).toBe("interrupt");
    expect(resolveActiveSendBehavior("queue", false)).toBe("queue");
    expect(resolveActiveSendBehavior("steer", true)).toBe("steer");
  });

  function actions() {
    const calls: string[] = [];
    return {
      calls,
      handleSendMessage: () => calls.push("send"),
      handleQueueMessage: () => calls.push("queue"),
      onQueue: () => undefined,
    };
  }

  it("uses Enter to interrupt and Mod+Enter to queue when interrupt is selected", () => {
    const defaultAction = actions();
    runDefaultSendAction({
      defaultSendBehavior: "interrupt",
      isAgentRunning: true,
      onQueue: defaultAction.onQueue,
      handleSendMessage: defaultAction.handleSendMessage,
      handleQueueMessage: defaultAction.handleQueueMessage,
    });

    const alternateAction = actions();
    runAlternateSendAction({
      defaultSendBehavior: "interrupt",
      isAgentRunning: true,
      onQueue: alternateAction.onQueue,
      handleSendMessage: alternateAction.handleSendMessage,
      handleQueueMessage: alternateAction.handleQueueMessage,
    });

    expect(defaultAction.calls).toEqual(["send"]);
    expect(alternateAction.calls).toEqual(["queue"]);
  });

  it("uses Enter to steer and Mod+Enter to queue when steer is selected", () => {
    const defaultAction = actions();
    runDefaultSendAction({
      defaultSendBehavior: "steer",
      isAgentRunning: true,
      onQueue: defaultAction.onQueue,
      handleSendMessage: defaultAction.handleSendMessage,
      handleQueueMessage: defaultAction.handleQueueMessage,
    });

    const alternateAction = actions();
    runAlternateSendAction({
      defaultSendBehavior: "steer",
      isAgentRunning: true,
      onQueue: alternateAction.onQueue,
      handleSendMessage: alternateAction.handleSendMessage,
      handleQueueMessage: alternateAction.handleQueueMessage,
    });

    expect(defaultAction.calls).toEqual(["send"]);
    expect(alternateAction.calls).toEqual(["queue"]);
  });

  it("uses Enter to queue and Mod+Enter to submit when queue is selected", () => {
    const defaultAction = actions();
    runDefaultSendAction({
      defaultSendBehavior: "queue",
      isAgentRunning: true,
      onQueue: defaultAction.onQueue,
      handleSendMessage: defaultAction.handleSendMessage,
      handleQueueMessage: defaultAction.handleQueueMessage,
    });

    const alternateAction = actions();
    runAlternateSendAction({
      defaultSendBehavior: "queue",
      isAgentRunning: true,
      onQueue: alternateAction.onQueue,
      handleSendMessage: alternateAction.handleSendMessage,
      handleQueueMessage: alternateAction.handleQueueMessage,
    });

    expect(defaultAction.calls).toEqual(["queue"]);
    expect(alternateAction.calls).toEqual(["send"]);
  });
});

describe("resolveAlternateSendActions", () => {
  it("offers every send action except the default while a turn runs", () => {
    expect(
      resolveAlternateSendActions({
        defaultSendBehavior: "steer",
        isAgentRunning: true,
        canQueue: true,
      }),
    ).toEqual(["queue", "interrupt"]);
    expect(
      resolveAlternateSendActions({
        defaultSendBehavior: "queue",
        isAgentRunning: true,
        canQueue: true,
      }),
    ).toEqual(["steer", "interrupt"]);
    expect(
      resolveAlternateSendActions({
        defaultSendBehavior: "interrupt",
        isAgentRunning: true,
        canQueue: true,
      }),
    ).toEqual(["steer", "queue"]);
  });

  it("offers nothing on an idle agent, and no queue where the composer cannot queue", () => {
    expect(
      resolveAlternateSendActions({
        defaultSendBehavior: "steer",
        isAgentRunning: false,
        canQueue: true,
      }),
    ).toEqual([]);
    expect(
      resolveAlternateSendActions({
        defaultSendBehavior: "steer",
        isAgentRunning: true,
        canQueue: false,
      }),
    ).toEqual(["interrupt"]);
  });
});

describe("deferred quick prompt sends", () => {
  const prompt: QuickPrompt = {
    id: "summary",
    title: "Summary",
    text: "Summarize.",
    mode: "send",
    pinned: true,
    isDefault: true,
  };
  function setup() {
    let context: QuickPromptContext = {
      host: "host",
      agent: "agent",
      conversation: "chat",
      connected: true,
      visible: true,
      foreground: true,
      available: true,
      policy: "queue",
      presentation: "wide",
      action: "queue",
    };
    const callbacks = new Set<() => void>();
    const delays: number[] = [];
    const sent: QuickPromptCapture[] = [];
    let disposition: "started" | "steered" | "queued" | undefined = "queued";
    let fail = false;
    const controller = createDeferredQuickPromptSend({
      readContext: () => context,
      schedule: (callback, delayMs) => {
        delays.push(delayMs);
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
      dispatch: async (capture) => {
        sent.push(capture);
        if (fail) throw new Error("offline");
        return disposition;
      },
    });
    return {
      controller,
      delays,
      sent,
      change(patch: Partial<QuickPromptContext>) {
        context = { ...context, ...patch };
      },
      tick() {
        const pending = [...callbacks];
        callbacks.clear();
        for (const callback of pending) {
          callback();
        }
      },
      reply(next: typeof disposition) {
        disposition = next;
      },
      fail(next: boolean) {
        fail = next;
      },
    };
  }
  it("waits, supports undo and never submits a cancelled timer", () => {
    const test = setup();
    test.controller.start(prompt, 2500);
    expect(test.sent).toEqual([]);
    expect(test.controller.getState().status).toBe("pending");
    test.controller.cancel();
    expect(test.controller.getState()).toEqual({ status: "cancelled" });
    expect(test.delays.at(-1)).toBe(2500);
    test.tick();
    expect(test.sent).toEqual([]);
    expect(test.controller.getState()).toEqual({ status: "idle" });
  });
  it("a second tap dispatches the captured text exactly once", async () => {
    const test = setup();
    test.controller.start(prompt, 2500);
    test.controller.start({ ...prompt, text: "Changed" }, 2500);
    test.controller.start(prompt, 2500);
    test.tick();
    await Promise.resolve();
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0].text).toBe("Summarize.");
    expect(test.controller.getState()).toEqual({ status: "idle" });
  });
  it("finishes the wait when a running turn ends and resolves send at dispatch", async () => {
    const test = setup();
    test.controller.start(prompt, 2500);
    test.change({ action: "send" });
    test.controller.validate();
    expect(test.controller.getState()).toMatchObject({
      status: "pending",
      capture: { action: "send" },
    });
    test.tick();
    await Promise.resolve();
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]).toMatchObject({ action: "send", context: { agent: "agent" } });
  });
  it("a stale picker callback and context change cannot remove the in-flight guard", async () => {
    const test = setup();
    const lateSelection = test.controller.guardSelection(() =>
      test.controller.start({ ...prompt, id: "second" }, 0),
    );
    test.controller.start(prompt, 0);
    const inflightSelection = test.controller.guardSelection(() =>
      test.controller.start({ ...prompt, id: "third" }, 0),
    );
    test.change({ policy: "changed" });
    test.controller.validate();
    lateSelection();
    inflightSelection();
    test.controller.cancel();
    test.controller.dismiss();
    test.controller.start({ ...prompt, id: "second" }, 0);
    expect(test.controller.getState().status).toBe("sending");
    expect(test.sent).toHaveLength(1);
    await Promise.resolve();
    expect(test.controller.getState().status).toBe("idle");
    test.controller.start({ ...prompt, id: "second" }, 0);
    expect(test.sent).toHaveLength(2);
  });
  it("only cancels a pending or failed send and permits dismissing the notice", () => {
    const test = setup();
    test.controller.cancel();
    expect(test.controller.getState().status).toBe("idle");
    test.controller.start(prompt, 2500);
    test.controller.cancel();
    expect(test.controller.getState().status).toBe("cancelled");
    test.controller.dismiss();
    expect(test.controller.getState().status).toBe("idle");
  });
  it("shows an expiring unavailable notice when a pane cannot send", () => {
    const test = setup();
    test.change({ visible: false });
    test.controller.start(prompt, 2500);
    expect(test.controller.getState().status).toBe("unavailable");
    test.tick();
    expect(test.controller.getState().status).toBe("idle");
    expect(test.sent).toEqual([]);
  });
  const changes: Array<[string, Partial<QuickPromptContext>]> = [
    ["host", { host: "other" }],
    ["agent", { agent: "other" }],
    ["conversation", { conversation: "other" }],
    ["panel hidden", { visible: false }],
    ["background", { foreground: false }],
    ["disconnect", { connected: false }],
    ["permission or policy", { policy: "permission-123" }],
    ["presentation", { presentation: "compact" }],
    ["voice or unavailable agent", { available: false }],
  ];
  it.each(changes)("cancels on %s immediately before dispatch", (_label, patch) => {
    const test = setup();
    test.controller.start(prompt, 2500);
    test.change(patch);
    test.tick();
    expect(test.sent).toEqual([]);
    expect(test.controller.getState()).toEqual({ status: "cancelled" });
  });
  it.each(["started", "steered", "queued"] as const)(
    "returns to idle after the daemon reports %s, with no confirmation",
    async (disposition) => {
      const test = setup();
      test.reply(disposition);
      test.controller.start(prompt, 0);
      await Promise.resolve();
      expect(test.controller.getState()).toEqual({ status: "idle" });
    },
  );
  it("never invents disposition feedback", async () => {
    const test = setup();
    test.reply(undefined);
    test.controller.start(prompt, 0);
    await Promise.resolve();
    expect(test.controller.getState()).toEqual({ status: "idle" });
  });
  it("failure retains its capture and requires explicit retry", async () => {
    const test = setup();
    test.fail(true);
    test.controller.start(prompt, 0);
    await Promise.resolve();
    test.tick();
    expect(test.sent).toHaveLength(1);
    expect(test.controller.getState()).toMatchObject({
      status: "failed",
      capture: { text: prompt.text },
    });
    test.fail(false);
    test.controller.retry(2500);
    expect(test.sent).toHaveLength(1);
    test.tick();
    await Promise.resolve();
    expect(test.sent).toHaveLength(2);
    expect(test.controller.getState()).toEqual({ status: "idle" });
  });
  it("cannot retry a failure against another conversation", async () => {
    const test = setup();
    test.fail(true);
    test.controller.start(prompt, 0);
    await Promise.resolve();
    test.change({ conversation: "other" });
    test.controller.retry(0);
    expect(test.sent).toHaveLength(1);
    expect(test.controller.getState().status).toBe("cancelled");
  });
  it("iOS menu teardown cannot retarget a delayed selection", () => {
    const test = setup();
    const select = test.controller.guardSelection(() => test.controller.start(prompt, 0));
    test.change({ agent: "different-agent" });
    select();
    expect(test.sent).toEqual([]);
    expect(test.controller.getState()).toEqual({ status: "unavailable" });
  });
  it("a transient policy change during menu teardown invalidates the captured selection", () => {
    const test = setup();
    const select = test.controller.guardSelection(() => test.controller.start(prompt, 0));
    test.change({ policy: "new-permission" });
    test.controller.validate();
    test.change({ policy: "queue" });
    select();
    expect(test.sent).toEqual([]);
    expect(test.controller.getState()).toEqual({ status: "unavailable" });
  });
  it("a transient disconnect cancels even if the connection recovers before the timer", () => {
    const test = setup();
    test.controller.start(prompt, 2500);
    test.change({ connected: false });
    test.controller.validate();
    expect(test.controller.getState()).toEqual({ status: "cancelled" });
    test.change({ connected: true });
    test.tick();
    expect(test.sent).toEqual([]);
    expect(test.controller.getState()).toEqual({ status: "idle" });
  });
  it("manual send and unmount cancel pending dispatch", () => {
    const test = setup();
    test.controller.start(prompt, 2500);
    test.controller.cancel();
    test.tick();
    expect(test.sent).toEqual([]);
    test.controller.start(prompt, 2500);
    test.controller.dispose();
    test.tick();
    expect(test.sent).toEqual([]);
  });
});

describe("quick prompt picker actions", () => {
  it("uses the selected default, then the first pinned favorite, for the toolbar shortcut", () => {
    const ordinary: QuickPrompt = {
      id: "ordinary",
      title: "Ordinary",
      text: "Ordinary prompt",
      mode: "send",
      pinned: false,
      isDefault: false,
    };
    const firstPinned = { ...ordinary, id: "first", pinned: true };
    const secondPinned = { ...ordinary, id: "second", pinned: true };
    const selected = { ...ordinary, id: "selected", isDefault: true };

    expect(resolveQuickPromptShortcut([ordinary, firstPinned, secondPinned, selected])).toEqual(
      selected,
    );
    expect(resolveQuickPromptShortcut([ordinary, firstPinned, secondPinned])).toEqual(firstPinned);
    expect(resolveQuickPromptShortcut([ordinary])).toBeUndefined();
    expect(resolveQuickPromptShortcut([])).toBeUndefined();
  });

  it("permits insert while sends are blocked, and only blocks inserts during a catalog write", () => {
    expect(isQuickPromptActionDisabled("insert", false, true)).toBe(false);
    expect(isQuickPromptActionDisabled("insert", true, false)).toBe(true);
    expect(isQuickPromptActionDisabled("send", false, true)).toBe(true);
  });

  const prompt: QuickPrompt = {
    id: "summary",
    title: "Summary",
    text: "Summarize.",
    mode: "insert",
    pinned: false,
    isDefault: false,
  };
  it("row sends, insert edits the draft, pin and default only persist", async () => {
    const sent: QuickPrompt[] = [];
    const inserted: string[] = [];
    const saved: QuickPrompt[][] = [];
    const ports = {
      send: (entry: QuickPrompt) => {
        sent.push(entry);
      },
      insert: (text: string) => {
        inserted.push(text);
      },
      save: async (next: QuickPrompt[]) => {
        saved.push(next);
      },
    };
    await selectQuickPrompt({ prompt, prompts: [prompt], action: "send", ports });
    expect(sent).toEqual([prompt]);
    expect(inserted).toEqual([]);
    expect(saved).toEqual([]);
    await selectQuickPrompt({ prompt, prompts: [prompt], action: "insert", ports });
    expect(inserted).toEqual([prompt.text]);
    expect(sent).toHaveLength(1);
    await selectQuickPrompt({ prompt, prompts: [prompt], action: "pin", ports });
    expect(saved[0]).toEqual([{ ...prompt, pinned: true }]);
    await selectQuickPrompt({
      prompt,
      prompts: [prompt, { ...prompt, id: "old", isDefault: true }],
      action: "default",
      ports,
    });
    expect(saved[1]).toEqual([
      { ...prompt, isDefault: true },
      { ...prompt, id: "old", isDefault: false },
    ]);
  });
  it("cannot pin a fourth prompt; moving preserves the list order", async () => {
    const pins = [0, 1, 2].map((id) => Object.assign({}, prompt, { id: String(id), pinned: true }));
    const saved: QuickPrompt[][] = [];
    await selectQuickPrompt({
      prompt,
      prompts: [...pins, prompt],
      action: "pin",
      ports: {
        send: () => {},
        insert: () => {},
        save: async (next) => {
          saved.push(next);
        },
      },
    });
    expect(saved).toEqual([]);
    expect(moveQuickPrompt([...pins, prompt], prompt.id, -1).map((entry) => entry.id)).toEqual([
      "0",
      "1",
      "summary",
      "2",
    ]);
  });
  it("fresh forms isolate edits; failed saves keep the entered values", async () => {
    const form = openQuickPromptForm(prompt, 0);
    form.set({ title: "My summary", text: "My edited prompt" });
    expect(
      await form.submit(async () => {
        throw new Error("Disconnected");
      }),
    ).toBe(false);
    expect(form.getState()).toMatchObject({
      error: "Disconnected",
      canSubmit: true,
      prompt: { title: "My summary", text: "My edited prompt" },
    });
    expect(openQuickPromptForm(prompt, 0).getState().prompt).toEqual(prompt);
    expect(updateQuickPrompt([prompt], { ...prompt, text: "Replacement" })).toEqual([
      { ...prompt, text: "Replacement" },
    ]);
  });
});
