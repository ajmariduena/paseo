import type { QuickPrompt } from "@getpaseo/protocol/messages";
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
