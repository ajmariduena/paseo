import { useEffect, useRef } from "react";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName);
}

/**
 * The slider is only mounted while its card is open, and the card has no text field, so the
 * card's lifetime is the key scope. Listening on the document rather than a focused element
 * means the arrows work the moment the card opens, without a click on the track first.
 */
export function useEffortSliderKeyboard(input: {
  enabled: boolean;
  onStep: (delta: number) => void;
}): void {
  const onStepRef = useRef(input.onStep);
  onStepRef.current = input.onStep;

  useEffect(() => {
    if (!input.enabled) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      onStepRef.current(event.key === "ArrowRight" ? 1 : -1);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [input.enabled]);
}
