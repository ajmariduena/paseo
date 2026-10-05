import { useLayoutEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { isWeb } from "@/constants/platform";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  createDeferredQuickPromptSend,
  type DeferredSendPorts,
  type QuickPromptContext,
} from "./deferred-send";

export function useDeferredQuickPromptSend(input: {
  readContext: () => Omit<QuickPromptContext, "foreground" | "visible" | "presentation">;
  dispatch: DeferredSendPorts["dispatch"];
}) {
  const panelActive = useRetainedPanelActive();
  const { isActiveComposer } = useComposerKeyboardScope();
  const visible = panelActive && isActiveComposer;
  const latest = useRef({ ...input, visible });
  latest.current = { ...input, visible };
  const surface = useRef({ presentation: "unmeasured", available: false });
  const foreground = useRef(AppState.currentState === "active");
  const [controller] = useState(() =>
    createDeferredQuickPromptSend({
      readContext: () => ({
        ...latest.current.readContext(),
        visible: latest.current.visible,
        available: latest.current.readContext().available && surface.current.available,
        presentation: surface.current.presentation,
        foreground: foreground.current && (!isWeb || document.visibilityState === "visible"),
      }),
      dispatch: (capture) => latest.current.dispatch(capture),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    }),
  );
  useLayoutEffect(() => controller.validate());
  useLayoutEffect(() => {
    const unsubscribe = useSessionStore.subscribe(() => controller.validate());
    const unsubscribeHost = getHostRuntimeStore().subscribeAll(() => controller.validate());
    const subscription = AppState.addEventListener("change", (state) => {
      foreground.current = state === "active";
      controller.validate();
    });
    const visibilityChanged = () => controller.validate();
    if (isWeb) document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      unsubscribe();
      unsubscribeHost();
      subscription.remove();
      if (isWeb) document.removeEventListener("visibilitychange", visibilityChanged);
      controller.cancel();
    };
  }, [controller]);
  const [binding] = useState(() => ({
    controller,
    setSurface(presentation: string, available: boolean) {
      surface.current = { presentation, available };
      controller.validate();
    },
  }));
  return binding;
}
