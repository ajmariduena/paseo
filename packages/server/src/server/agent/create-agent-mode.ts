import type {
  AgentCreateConfigParent,
  AgentCreateConfigUnattendedInput,
  AgentMode,
  AgentProvider,
  ResolveAgentCreateConfigInput,
  ResolveAgentCreateConfigResult,
} from "./agent-sdk-types.js";

export interface ResolveCreateAgentModeInput {
  requestedMode: string | undefined;
  targetProvider: AgentProvider;
  parent: AgentCreateConfigParent | null;
  unattended: boolean;
  // `undefined` = target provider's modes unknown: explicit modes pass through
  // unvalidated, but cross-provider inheritance is still refused.
  // `[]` = target provider explicitly has no modes: use its default behavior.
  availableModes: string[] | undefined;
  // Target provider's own unattended mode id, if it has one. Used to bridge
  // unattended parents into unattended children across providers.
  targetUnattendedMode: string | undefined;
  // Target modes with manifest metadata (colorTier, isUnattended), for mapping a
  // cross-provider parent's mode by permission level.
  targetModes?: readonly AgentMode[];
  targetDefaultModeId?: string | null;
}

function listModes(modes: string[] | undefined): string {
  if (modes === undefined) {
    return "unknown";
  }
  return modes.length > 0 ? modes.join(", ") : "(none)";
}

function isUnattendedCreateConfigParent(parent: AgentCreateConfigParent): boolean {
  return parent.isUnattended;
}

function formatCreateConfigParentMode(parent: AgentCreateConfigParent): string {
  return parent.modeId ?? "<none>";
}

function formatCreateConfigParentSource(parent: AgentCreateConfigParent): string {
  return `caller (provider '${parent.provider}')`;
}

export function resolveAndValidateCreateAgentMode(
  input: ResolveCreateAgentModeInput,
): string | undefined {
  const { requestedMode, targetProvider, parent, availableModes } = input;

  if (requestedMode !== undefined) {
    if (availableModes !== undefined && !availableModes.includes(requestedMode)) {
      throw new Error(
        `Invalid mode '${requestedMode}' for provider '${targetProvider}'. Available modes: ${listModes(availableModes)}`,
      );
    }
    return requestedMode;
  }

  if (!parent) {
    if (input.unattended && input.targetUnattendedMode !== undefined) {
      return input.targetUnattendedMode;
    }
    return undefined;
  }

  if (parent.provider === targetProvider) {
    return parent.modeId ?? undefined;
  }

  if (
    (input.unattended || isUnattendedCreateConfigParent(parent)) &&
    input.targetUnattendedMode !== undefined
  ) {
    return input.targetUnattendedMode;
  }

  if (availableModes?.length === 0) {
    return undefined;
  }

  const mapped = mapModeByPermissionLevel(parent, input.targetModes, input.targetDefaultModeId);
  if (mapped !== undefined) {
    return mapped;
  }

  throw new Error(
    `cannot inherit mode '${formatCreateConfigParentMode(parent)}' from ${formatCreateConfigParentSource(parent)} for new agent (provider '${targetProvider}'). Pass an explicit mode. Available modes for '${targetProvider}': ${listModes(availableModes)}`,
  );
}

/** planning < asks before acting < approves edits on its own < runs without prompts */
type PermissionLevel = 0 | 1 | 2 | 3;

function modePermissionLevel(mode: AgentMode | undefined): PermissionLevel | null {
  if (!mode) return null;
  if (mode.isUnattended) return 3;
  switch (mode.colorTier) {
    case "planning":
      return 0;
    case "safe":
      return 1;
    case "moderate":
      return 2;
    case "dangerous":
      return 3;
    default:
      return null;
  }
}

// Levels to try, nearest first, never above the parent's tier. "Asks" and "approves edits" share
// a tier: Codex has no asking mode, and refusing it would stop every Claude default agent from
// delegating to Codex.
const FALLBACK_LEVELS: Record<PermissionLevel, readonly PermissionLevel[]> = {
  0: [0],
  1: [1, 2, 0],
  2: [2, 1, 0],
  3: [3, 2, 1, 0],
};

function mapModeByPermissionLevel(
  parent: AgentCreateConfigParent,
  targetModes: readonly AgentMode[] | undefined,
  targetDefaultModeId: string | null | undefined,
): string | undefined {
  if (!targetModes || targetModes.length === 0) return undefined;
  const parentLevel = parent.isUnattended ? 3 : modePermissionLevel(parent.mode);
  if (parentLevel === null) return undefined;
  const targetDefault = targetModes.find((mode) => mode.id === targetDefaultModeId);
  for (const level of FALLBACK_LEVELS[parentLevel]) {
    const atLevel = targetModes.filter((mode) => modePermissionLevel(mode) === level);
    const picked =
      atLevel.find((mode) => mode.id === parent.modeId) ??
      atLevel.find((mode) => mode === targetDefault) ??
      atLevel[0];
    if (picked) return picked.id;
    if (parentLevel === 3 && level === 3 && targetDefault) return targetDefault.id;
  }
  return undefined;
}

/** Fills in a runtime mode's manifest metadata, which providers don't report themselves. */
export function withManifestModeMetadata(
  modes: AgentMode[],
  definitionModes: readonly AgentMode[],
): AgentMode[] {
  return modes.map((mode) => {
    const definitionMode = definitionModes.find((candidate) => candidate.id === mode.id);
    if (!definitionMode) return mode;
    const isUnattended = mode.isUnattended ?? definitionMode.isUnattended;
    return {
      ...mode,
      icon: mode.icon ?? definitionMode.icon,
      colorTier: mode.colorTier ?? definitionMode.colorTier,
      ...(isUnattended !== undefined ? { isUnattended } : {}),
    };
  });
}

export function resolveDefaultAgentCreateConfig(
  input: ResolveAgentCreateConfigInput,
): ResolveAgentCreateConfigResult {
  const availableModeIds = input.availableModes?.map((mode) => mode.id);
  return {
    modeId: resolveAndValidateCreateAgentMode({
      requestedMode: input.requestedMode,
      targetProvider: input.provider,
      parent: input.parent,
      unattended: input.unattended,
      availableModes: availableModeIds,
      targetUnattendedMode: input.availableModes?.find(isUnattendedMode)?.id,
      targetModes: input.availableModes,
      targetDefaultModeId: input.defaultModeId,
    }),
    featureValues: input.featureValues,
  };
}

export function isDefaultAgentCreateConfigUnattended(
  input: AgentCreateConfigUnattendedInput,
): boolean {
  if (input.modeId === null) {
    return false;
  }
  return input.availableModes.some((mode) => mode.id === input.modeId && isUnattendedMode(mode));
}

function isUnattendedMode(mode: AgentMode): boolean {
  return mode.isUnattended === true;
}
