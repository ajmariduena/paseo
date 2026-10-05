import type { QuickPrompt } from "@getpaseo/protocol/messages";
import type { ComposerSendDisposition } from "@/composer/actions";
import type { ComposerSendAction } from "@/composer/input/state";

export interface QuickPromptContext {
  host: string;
  agent: string;
  conversation: string;
  connected: boolean;
  visible: boolean;
  foreground: boolean;
  available: boolean;
  policy: string;
  presentation: string;
  action: ComposerSendAction | "send";
}

export interface QuickPromptCapture {
  context: QuickPromptContext;
  promptId: string;
  title: string;
  text: string;
  action: QuickPromptContext["action"];
}

export type QuickPromptSendState =
  | { status: "idle" | "cancelled" }
  | { status: "pending" | "sending" | "failed"; capture: QuickPromptCapture }
  | {
      status: "accepted";
      capture: QuickPromptCapture;
      disposition: NonNullable<ComposerSendDisposition>;
    };

export interface DeferredSendPorts {
  readContext: () => QuickPromptContext;
  dispatch: (capture: QuickPromptCapture) => Promise<ComposerSendDisposition>;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

function canSend(context: QuickPromptContext): boolean {
  return context.connected && context.visible && context.foreground && context.available;
}

function sameContext(left: QuickPromptContext, right: QuickPromptContext): boolean {
  return (Object.keys(left) as Array<keyof QuickPromptContext>).every(
    (key) => left[key] === right[key],
  );
}

/** The captured target is immutable; timers and retry never select a new destination. */
export function createDeferredQuickPromptSend(ports: DeferredSendPorts) {
  let state: QuickPromptSendState = { status: "idle" };
  let cancelTimer: (() => void) | null = null;
  let disposed = false;
  let selectionVersion = 0;
  let selectionContext: QuickPromptContext | null = null;
  const listeners = new Set<() => void>();
  function publish(next: QuickPromptSendState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function clearTimer() {
    cancelTimer?.();
    cancelTimer = null;
  }
  function cancel() {
    selectionVersion++;
    selectionContext = null;
    if (state.status !== "pending" && state.status !== "failed") return;
    clearTimer();
    publish({ status: "cancelled" });
  }
  function validate() {
    if (selectionContext && !sameContext(selectionContext, ports.readContext())) {
      cancel();
      publish({ status: "cancelled" });
    }
    if (state.status !== "pending" && state.status !== "failed") return;
    const current = ports.readContext();
    if (!canSend(current) || !sameContext(state.capture.context, current)) cancel();
  }
  async function dispatch() {
    validate();
    if (disposed || state.status !== "pending") return;
    clearTimer();
    const capture = state.capture;
    publish({ status: "sending", capture });
    try {
      const disposition = await ports.dispatch(capture);
      if (disposed) return;
      publish(disposition ? { status: "accepted", capture, disposition } : { status: "idle" });
      if (disposition) {
        cancelTimer = ports.schedule(() => {
          if (state.status === "accepted" && state.capture === capture) publish({ status: "idle" });
        }, 1200);
      }
    } catch {
      if (!disposed) publish({ status: "failed", capture });
    }
  }
  function start(prompt: QuickPrompt, delayMs: number) {
    if (disposed || state.status === "sending") return;
    validate();
    if (state.status === "pending" && state.capture.promptId === prompt.id) {
      void dispatch();
      return;
    }
    cancel();
    clearTimer();
    const context = { ...ports.readContext() };
    if (!canSend(context)) return;
    const capture = {
      context,
      promptId: prompt.id,
      title: prompt.title,
      text: prompt.text,
      action: context.action,
    };
    publish({ status: "pending", capture });
    if (delayMs === 0) void dispatch();
    else cancelTimer = ports.schedule(() => void dispatch(), delayMs);
  }
  function retry(delayMs: number) {
    validate();
    if (state.status !== "failed") return;
    const capture = state.capture;
    publish({ status: "pending", capture });
    if (delayMs === 0) void dispatch();
    else cancelTimer = ports.schedule(() => void dispatch(), delayMs);
  }
  function guardSelection(action: () => void) {
    const expected = { ...ports.readContext() };
    selectionContext = expected;
    const version = ++selectionVersion;
    return () => {
      if (disposed) return;
      validate();
      if (version !== selectionVersion || !sameContext(expected, ports.readContext())) {
        cancel();
        publish({ status: "cancelled" });
        return;
      }
      selectionContext = null;
      action();
    };
  }
  return {
    guardSelection,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    cancel,
    validate,
    retry,
    dispose() {
      cancel();
      disposed = true;
      clearTimer();
      listeners.clear();
    },
  };
}
export type DeferredQuickPromptSend = ReturnType<typeof createDeferredQuickPromptSend>;
