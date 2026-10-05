/** Arrow keys only exist on desktop; the web file carries the listener. */
export function useEffortSliderKeyboard(_input: {
  enabled: boolean;
  onStep: (delta: number) => void;
}): void {}
