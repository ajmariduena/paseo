/**
 * The ordinal model behind the effort slider. A model's `thinkingOptions` are the stops, in the
 * order the provider lists them; nothing here knows what "medium" means, only where it sits.
 */

export interface EffortStopOption {
  id: string;
  isDefault?: boolean;
}

/**
 * `top` is the last stop of any scale with two or more stops and is the only stop drawn as its
 * own family. The others split the remaining stops into thirds.
 */
export type EffortTier = "low" | "mid" | "high" | "top";

export function resolveEffortStopIndex(
  options: readonly EffortStopOption[],
  selectedId: string | null | undefined,
): number {
  const index = options.findIndex((option) => option.id === selectedId);
  return index === -1 ? resolveEffortDefaultIndex(options) : index;
}

export function resolveEffortDefaultIndex(options: readonly EffortStopOption[]): number {
  const index = options.findIndex((option) => option.isDefault);
  return index === -1 ? 0 : index;
}

export function resolveEffortTier(index: number, count: number): EffortTier {
  if (count < 2) return "low";
  if (index >= count - 1) return "top";
  const position = index / Math.max(1, count - 2);
  if (position < 1 / 3) return "low";
  if (position < 2 / 3) return "mid";
  return "high";
}

export function clampEffortIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}

/** Where a stop sits along the track, 0 at the first stop and 1 at the last. */
export function effortStopRatio(index: number, count: number): number {
  if (count < 2) return 0;
  return clampEffortIndex(index, count) / (count - 1);
}

/** The nearest stop to a point along the track — the magnet. */
export function effortStopFromRatio(ratio: number, count: number): number {
  if (count < 2) return 0;
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  return clampEffortIndex(Math.round(clampedRatio * (count - 1)), count);
}

export function stepEffortIndex(index: number, delta: number, count: number): number {
  return clampEffortIndex(index + delta, count);
}

/**
 * The effort to run after switching models: the current one when the new model offers it,
 * otherwise the new model's default. `null` when the model has no effort scale at all.
 */
export function resolveEffortAfterModelSwitch(input: {
  thinkingOptions: readonly EffortStopOption[] | null | undefined;
  currentThinkingOptionId: string | null | undefined;
}): string | null {
  const options = input.thinkingOptions ?? [];
  if (options.length === 0) return null;
  const current = options.find((option) => option.id === input.currentThinkingOptionId);
  if (current) return current.id;
  return options[resolveEffortDefaultIndex(options)]?.id ?? null;
}

/** Effort and Fast stay reachable on providers that cannot switch models. */
export function hasModelEffortControl(input: {
  canSelectModel: boolean;
  effortCount: number;
  hasFast: boolean;
}): boolean {
  return input.canSelectModel || input.effortCount > 1 || input.hasFast;
}
