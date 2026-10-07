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
  | { status: "idle" | "cancelled" | "unavailable" }
  | { status: "pending" | "sending" | "failed"; capture: QuickPromptCapture };

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
    (key) => key === "action" || left[key] === right[key],
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
  function dismiss() {
    if (state.status === "sending" || state.status === "pending") return;
    clearTimer();
    publish({ status: "idle" });
  }
  function notice(status: "cancelled" | "unavailable") {
    clearTimer();
    const next = { status };
    publish(next);
    cancelTimer = ports.schedule(() => {
      if (state === next) publish({ status: "idle" });
    }, 2500);
  }
  function invalidateSelection() {
    selectionVersion++;
    selectionContext = null;
  }
  function unavailable() {
    if (state.status === "sending" || state.status === "pending" || state.status === "failed")
      return;
    notice("unavailable");
  }
  function cancel() {
    invalidateSelection();
    if (state.status !== "pending" && state.status !== "failed") return;
    notice("cancelled");
  }
  function validate() {
    const current = ports.readContext();
    if (selectionContext && !sameContext(selectionContext, current)) invalidateSelection();
    if (state.status !== "pending" && state.status !== "failed") return;
    if (!canSend(current) || !sameContext(state.capture.context, current)) {
      cancel();
    } else if (state.capture.action !== current.action) {
      publish({ ...state, capture: { ...state.capture, action: current.action } });
    }
  }
  async function dispatch() {
    validate();
    if (disposed || state.status !== "pending") return;
    clearTimer();
    const capture = { ...state.capture, action: ports.readContext().action };
    invalidateSelection();
    publish({ status: "sending", capture });
    try {
      await ports.dispatch(capture);
      if (disposed) return;
      publish({ status: "idle" });
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
    if (!canSend(context)) {
      unavailable();
      return;
    }
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
        unavailable();
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
    dismiss,
    unavailable,
    validate,
    retry,
    sendNow: () => {
      void dispatch();
    },
    dispose() {
      cancel();
      disposed = true;
      clearTimer();
      listeners.clear();
    },
  };
}
export type DeferredQuickPromptSend = ReturnType<typeof createDeferredQuickPromptSend>;
