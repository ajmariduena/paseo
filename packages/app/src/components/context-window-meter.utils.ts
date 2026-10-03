export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

export type ContextWindowTone = "normal" | "warning" | "danger";

export const CONTEXT_WINDOW_WARNING_PERCENTAGE = 75;
const CONTEXT_WINDOW_DANGER_PERCENTAGE = 90;

export function resolveContextWindowTone(percentage: number): ContextWindowTone {
  if (percentage > CONTEXT_WINDOW_DANGER_PERCENTAGE) return "danger";
  if (percentage >= CONTEXT_WINDOW_WARNING_PERCENTAGE) return "warning";
  return "normal";
}
