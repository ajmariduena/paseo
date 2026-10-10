import {
  resolveEffortDefaultIndex,
  resolveEffortStopIndex,
  resolveEffortTier,
  type EffortTier,
} from "@/components/ui/effort-stops";

export interface EffortOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface EffortSelection {
  /** Two or more stops make a scale; one or none is managed by the model. */
  hasEffort: boolean;
  index: number;
  tier: EffortTier;
  isTop: boolean;
  isDefault: boolean;
  selected: EffortOption | null;
  /** The selected stop's id and label, empty without stops. */
  selectedId: string;
  selectedLabel: string;
}

export function resolveEffortSelection(
  options: readonly EffortOption[],
  selectedId: string | undefined,
): EffortSelection {
  const hasEffort = options.length > 1;
  const index = resolveEffortStopIndex(options, selectedId);
  const tier = resolveEffortTier(index, options.length);
  const selected = options[index] ?? null;
  return {
    hasEffort,
    index,
    tier: hasEffort ? tier : "low",
    isTop: hasEffort && tier === "top",
    isDefault: index === resolveEffortDefaultIndex(options),
    selected,
    selectedId: selected?.id ?? "",
    selectedLabel: selected?.label ?? "",
  };
}

/** The gauge reads the tier at a glance: quiet, accent, warning, then the top stop's purple. */
export const GAUGE_TIER_COLOR = {
  low: "foregroundMuted",
  mid: "accentBright",
  high: "statusWarning",
  top: "statusMerged",
} as const satisfies Record<EffortTier, string>;

/** The trigger's spoken value: model, level, and the speed only while it is on. */
export function describeIntelligence(input: {
  modelLabel: string;
  effortLabel: string | null;
  fastLabel: string | null | undefined;
  isFast: boolean;
}): string {
  const parts = [input.modelLabel, input.effortLabel, input.isFast ? input.fastLabel : null];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}
