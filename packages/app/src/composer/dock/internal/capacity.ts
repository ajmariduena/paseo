interface ComposerGeometry {
  height: number;
  bottomInset: number;
  keyboardShift: number;
  centered: boolean;
  safeAreaBottom: number;
}

export interface ComposerCapacity {
  keyboardReserve: number;
  capacity: number;
}

/** Space a centered form keeps between its bottom edge and the keyboard. */
export const CENTERED_KEYBOARD_GAP = 12;

export function resolveComposerCapacity(input: ComposerGeometry): number {
  "worklet";
  if (!input.centered) {
    return Math.max(0, input.height - input.bottomInset - input.keyboardShift - 5);
  }
  // A centered form rises only until it clears the keyboard, so with the keyboard open it has to
  // fit between the header and the keyboard on its own. A tablet keyboard can cover more than
  // half the viewport, which rules out keeping it centered in the space that is left.
  const keyboardTop =
    input.keyboardShift > 0
      ? input.height - input.keyboardShift - input.safeAreaBottom - CENTERED_KEYBOARD_GAP
      : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(input.height - input.bottomInset, keyboardTop) - 5);
}

export function updateComposerCapacity(
  previous: ComposerCapacity | undefined,
  input: ComposerGeometry,
): ComposerCapacity {
  "worklet";
  if (input.height <= 0 && previous) return previous;
  // Closing the keyboard moves the composer; it does not enlarge its editing
  // capacity. A subsequent keyboard opening supplies the next reservation.
  const keyboardReserve =
    input.keyboardShift > 0 ? input.keyboardShift : (previous?.keyboardReserve ?? 0);
  return {
    keyboardReserve,
    capacity: resolveComposerCapacity({ ...input, keyboardShift: keyboardReserve }),
  };
}
