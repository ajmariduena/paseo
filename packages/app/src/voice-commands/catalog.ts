import type {
  VoiceCommandsModel,
  VoiceCommandsOption,
  VoiceCommandsSettings,
} from "@getpaseo/protocol/voice-commands/rpc-schemas";

export type VoiceCommandsTarget = "selection" | "backup";

/** Any OpenAI-compatible endpoint; its API key is optional. */
export const CUSTOM_PROVIDER = "custom";

export interface VoiceCommandsOptionGroup {
  provider: string;
  label: string;
  options: VoiceCommandsOption[];
}

export interface VoiceCommandsKeyRow {
  provider: string;
  label: string;
  hasKey: boolean;
  optional: boolean;
}

export interface VoiceCommandsModelLabels {
  provider: string;
  model: string;
}

export interface VoiceCommandsFooter {
  /** Null when calls hand every request to the agent. */
  active: VoiceCommandsModelLabels | null;
  /** The selection that cannot answer until its provider has a key. */
  missingKey: VoiceCommandsModelLabels | null;
}

export type LatencyTone = "success" | "warning" | "error";

export type RoundTripBadge = { kind: "time"; ms: number; tone: LatencyTone } | { kind: "failed" };

export function sameModel(a: VoiceCommandsModel | null, b: VoiceCommandsModel | null): boolean {
  if (!a || !b) return a === b;
  return a.provider === b.provider && a.model === b.model;
}

export function getProviderLabel(settings: VoiceCommandsSettings, provider: string): string {
  return settings.providers.find((entry) => entry.id === provider)?.label ?? provider;
}

export function getModelLabels(
  settings: VoiceCommandsSettings,
  model: VoiceCommandsModel,
): VoiceCommandsModelLabels {
  const option = settings.options.find((entry) => sameModel(entry, model));
  return {
    provider: getProviderLabel(settings, model.provider),
    model: option?.label ?? model.model,
  };
}

function providerHasKey(settings: VoiceCommandsSettings, provider: string): boolean {
  return settings.providers.find((entry) => entry.id === provider)?.hasKey === true;
}

function needsKey(settings: VoiceCommandsSettings, provider: string): boolean {
  return provider !== CUSTOM_PROVIDER && !providerHasKey(settings, provider);
}

/** The catalog grouped by provider, in the host's provider order. */
export function groupOptions(settings: VoiceCommandsSettings): VoiceCommandsOptionGroup[] {
  const groups = new Map<string, VoiceCommandsOptionGroup>();
  for (const provider of settings.providers) {
    if (provider.id === CUSTOM_PROVIDER) continue;
    groups.set(provider.id, { provider: provider.id, label: provider.label, options: [] });
  }
  for (const option of settings.options) {
    if (option.provider === CUSTOM_PROVIDER) continue;
    let group = groups.get(option.provider);
    if (!group) {
      group = { provider: option.provider, label: option.provider, options: [] };
      groups.set(option.provider, group);
    }
    group.options.push(option);
  }
  return [...groups.values()].filter((group) => group.options.length > 0);
}

/** The selection's key row, plus the backup's when it is on another provider and has no key. */
export function getKeyRows(settings: VoiceCommandsSettings): VoiceCommandsKeyRow[] {
  const { selection, backup } = settings;
  if (!selection) return [];
  const row = (provider: string): VoiceCommandsKeyRow => ({
    provider,
    label: getProviderLabel(settings, provider),
    hasKey: providerHasKey(settings, provider),
    optional: provider === CUSTOM_PROVIDER,
  });
  const rows = [row(selection.provider)];
  if (backup && backup.provider !== selection.provider && needsKey(settings, backup.provider)) {
    rows.push(row(backup.provider));
  }
  return rows;
}

export function getFooter(settings: VoiceCommandsSettings): VoiceCommandsFooter {
  const { active, selection } = settings;
  return {
    active: active ? getModelLabels(settings, active) : null,
    missingKey:
      selection && needsKey(settings, selection.provider)
        ? getModelLabels(settings, selection)
        : null,
  };
}

/** Test exercises whatever answers now. */
export function getTestTarget(settings: VoiceCommandsSettings): VoiceCommandsTarget | null {
  if (!settings.active) return null;
  if (
    !sameModel(settings.active, settings.selection) &&
    sameModel(settings.active, settings.backup)
  ) {
    return "backup";
  }
  return "selection";
}

export function getLatencyTone(ms: number): LatencyTone {
  if (ms < 600) return "success";
  if (ms < 2000) return "warning";
  return "error";
}

export function getRoundTripBadge(
  settings: VoiceCommandsSettings,
  test: { failed: boolean; roundTripMs: number | null },
): RoundTripBadge | null {
  if (test.failed) return { kind: "failed" };
  const ms = test.roundTripMs ?? settings.lastRoundTripMs;
  if (!settings.active || ms === null) return null;
  return { kind: "time", ms, tone: getLatencyTone(ms) };
}

/** Seconds with two decimals under one second ("0.34"), one above ("1.4"). */
export function formatRoundTripSeconds(ms: number, locale: string): string {
  const digits = ms < 1000 ? 2 : 1;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(ms / 1000);
}
