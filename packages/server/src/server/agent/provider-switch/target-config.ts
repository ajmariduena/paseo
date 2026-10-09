import type {
  AgentMode,
  AgentModelDefinition,
  AgentModelTransitionPlan,
  AgentSessionSelectionChange,
} from "../agent-sdk-types.js";
import type { SerializableAgentConfig } from "../agent-storage.js";
import { modePermissionLevel, type PermissionLevel } from "../create-agent-mode.js";

export interface SwitchSource {
  /** Exact alias. */
  provider: string;
  driver: string;
  config: SerializableAgentConfig;
  /** The alias's modes with manifest metadata, so the current mode's authority is known. */
  modes: readonly AgentMode[];
}

export interface SwitchTarget {
  provider: string;
  driver: string;
  models: readonly AgentModelDefinition[];
  modes: readonly AgentMode[];
  defaultModeId: string | null;
  /** Feature ids the target lists for the resolved model; others are dropped. */
  featureIds: readonly string[];
  supportsMcpServers: boolean;
  appliesToolPolicy: boolean;
  /** The live session's classifier, for a same-alias change. */
  planModelTransition?: (change: AgentSessionSelectionChange) => AgentModelTransitionPlan;
}

export interface SwitchRequest {
  model?: string | null;
  modeId?: string;
  thinkingOptionId?: string | null;
}

export type TargetConfigRejection =
  | { kind: "mode_required"; reason: "broader" | "unmappable"; candidates: string[] }
  | { kind: "mode_unknown"; modeId: string }
  | { kind: "model_unavailable"; model: string }
  | { kind: "tool_policy_unsupported" }
  | { kind: "mcp_servers_unsupported" }
  | { kind: "transition_rejected"; reason: string };

export interface ResolvedTargetConfig {
  provider: string;
  config: SerializableAgentConfig;
  /** What the source carried that the target cannot: dropped, never silently substituted. */
  droppedFeatureIds: string[];
  droppedThinkingOptionId: string | null;
  transition: AgentModelTransitionPlan["kind"] | "new_segment";
}

export type TargetConfigPlan =
  | { status: "resolved"; target: ResolvedTargetConfig }
  | { status: "rejected"; rejection: TargetConfigRejection };

export interface PlanTargetConfigInput {
  source: SwitchSource;
  target: SwitchTarget;
  request: SwitchRequest;
}

interface EffectivePolicy {
  planning: boolean;
  level: PermissionLevel | null;
}

function isPlanningMode(mode: AgentMode | undefined): boolean {
  return mode?.colorTier === "planning";
}

function effectivePolicy(source: SwitchSource): EffectivePolicy {
  const mode = source.modes.find((candidate) => candidate.id === source.config.modeId);
  const planning = isPlanningMode(mode) || source.config.featureValues?.plan_mode === true;
  return { planning, level: modePermissionLevel(mode) };
}

/** A request field wins; otherwise the source value carries only within the same driver. */
function inherited<T>(requested: T | undefined, sameDriver: boolean, sourceValue: T): T {
  if (requested !== undefined) return requested;
  return sameDriver ? sourceValue : (null as T);
}

function defaultModelId(models: readonly AgentModelDefinition[]): string | null {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
}

function findModel(
  models: readonly AgentModelDefinition[],
  modelId: string,
): AgentModelDefinition | undefined {
  return models.find((model) => model.id === modelId || model.aliases?.includes(modelId));
}

function narrowestModeAtOrBelow(
  modes: readonly AgentMode[],
  level: PermissionLevel,
  preferredId: string | null,
  defaultModeId: string | null,
): AgentMode | null {
  for (let candidate = level; candidate >= 0; candidate -= 1) {
    const atLevel = modes.filter((mode) => modePermissionLevel(mode) === candidate);
    const picked =
      atLevel.find((mode) => mode.id === preferredId) ??
      atLevel.find((mode) => mode.id === defaultModeId) ??
      atLevel[0];
    if (picked) return picked;
  }
  return null;
}

interface ResolvedPolicy {
  modeId: string | undefined;
  planMode: boolean;
}

/**
 * Permission and planning come first and only ever narrow: a target mode at the same or a
 * lower authority maps on its own, anything else needs the user's explicit choice.
 */
function resolvePolicy(
  input: PlanTargetConfigInput,
): { ok: true; policy: ResolvedPolicy } | { ok: false; rejection: TargetConfigRejection } {
  const { source, target, request } = input;
  const current = effectivePolicy(source);
  const targetHasPlanFeature = target.featureIds.includes("plan_mode");
  if (request.modeId !== undefined) {
    const requested = target.modes.find((mode) => mode.id === request.modeId);
    if (!requested && target.modes.length > 0) {
      return { ok: false, rejection: { kind: "mode_unknown", modeId: request.modeId } };
    }
    const planMode = current.planning && !isPlanningMode(requested) && targetHasPlanFeature;
    return { ok: true, policy: { modeId: request.modeId, planMode } };
  }
  if (target.modes.length === 0) {
    return {
      ok: true,
      policy: { modeId: undefined, planMode: current.planning && targetHasPlanFeature },
    };
  }
  const candidates = target.modes.map((mode) => mode.id);
  if (current.planning) {
    const planningMode = target.modes.find(isPlanningMode);
    if (planningMode) return { ok: true, policy: { modeId: planningMode.id, planMode: false } };
    // Planning on a provider without a planning mode rides on its feature, under the narrowest
    // authority the provider offers below "approves edits".
    const base = targetHasPlanFeature
      ? narrowestModeAtOrBelow(target.modes, 1, null, target.defaultModeId)
      : null;
    if (base) return { ok: true, policy: { modeId: base.id, planMode: true } };
    return { ok: false, rejection: { kind: "mode_required", reason: "unmappable", candidates } };
  }
  if (current.level === null) {
    return { ok: false, rejection: { kind: "mode_required", reason: "unmappable", candidates } };
  }
  const mapped = narrowestModeAtOrBelow(
    target.modes,
    current.level,
    source.config.modeId ?? null,
    target.defaultModeId,
  );
  if (!mapped) {
    return { ok: false, rejection: { kind: "mode_required", reason: "broader", candidates } };
  }
  return { ok: true, policy: { modeId: mapped.id, planMode: false } };
}

function resolveModel(
  input: PlanTargetConfigInput,
):
  | { ok: true; model: AgentModelDefinition | null }
  | { ok: false; rejection: TargetConfigRejection } {
  const { source, target, request } = input;
  const sameDriver = source.driver === target.driver;
  const requested = inherited<string | null>(
    request.model,
    sameDriver,
    source.config.model ?? null,
  );
  const modelId = requested ?? defaultModelId(target.models);
  if (modelId === null) return { ok: true, model: null };
  const model = findModel(target.models, modelId);
  if (!model) return { ok: false, rejection: { kind: "model_unavailable", model: modelId } };
  return { ok: true, model };
}

function resolveThinking(
  input: PlanTargetConfigInput,
  model: AgentModelDefinition | null,
): { thinkingOptionId: string | null; dropped: string | null } {
  const { source, target, request } = input;
  const sameDriver = source.driver === target.driver;
  const requested = inherited<string | null>(
    request.thinkingOptionId,
    sameDriver,
    source.config.thinkingOptionId ?? null,
  );
  if (requested === null) return { thinkingOptionId: null, dropped: null };
  const options = model?.thinkingOptions;
  if (!options || options.some((option) => option.id === requested)) {
    return { thinkingOptionId: requested, dropped: null };
  }
  return { thinkingOptionId: null, dropped: requested };
}

function resolveFeatures(
  input: PlanTargetConfigInput,
  planMode: boolean,
): { featureValues: Record<string, unknown> | undefined; dropped: string[] } {
  const { source, target } = input;
  const carried: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [featureId, value] of Object.entries(source.config.featureValues ?? {})) {
    if (featureId === "plan_mode") continue;
    if (target.featureIds.includes(featureId)) {
      carried[featureId] = value;
    } else {
      dropped.push(featureId);
    }
  }
  if (planMode) carried.plan_mode = true;
  return { featureValues: Object.keys(carried).length > 0 ? carried : undefined, dropped };
}

/**
 * Pure: the configuration the target alias runs with, or why the picker has to ask or refuse.
 * Workspace, cwd, title, labels and owner are carried by the caller; this covers the session
 * config and nothing that needs a live provider.
 */
export function planTargetConfig(input: PlanTargetConfigInput): TargetConfigPlan {
  const { source, target } = input;
  const sameAlias = source.provider === target.provider;
  const sameDriver = source.driver === target.driver;
  if (source.config.toolPolicy && !target.appliesToolPolicy) {
    return { status: "rejected", rejection: { kind: "tool_policy_unsupported" } };
  }
  if (Object.keys(source.config.mcpServers ?? {}).length > 0 && !target.supportsMcpServers) {
    return { status: "rejected", rejection: { kind: "mcp_servers_unsupported" } };
  }
  const policy = resolvePolicy(input);
  if (!policy.ok) return { status: "rejected", rejection: policy.rejection };
  const model = resolveModel(input);
  if (!model.ok) return { status: "rejected", rejection: model.rejection };
  const thinking = resolveThinking(input, model.model);
  const features = resolveFeatures(input, policy.policy.planMode);

  let transition: ResolvedTargetConfig["transition"] = "new_segment";
  if (sameAlias && target.planModelTransition) {
    const plan = target.planModelTransition({
      model: model.model?.id ?? null,
      modeId: policy.policy.modeId,
      thinkingOptionId: thinking.thinkingOptionId,
      featureValues: features.featureValues ?? {},
    });
    if (plan.kind === "reject") {
      return {
        status: "rejected",
        rejection: { kind: "transition_rejected", reason: plan.reason },
      };
    }
    transition = plan.kind;
  } else if (sameAlias) {
    transition = "restart_session";
  }

  return {
    status: "resolved",
    target: {
      provider: target.provider,
      config: {
        modeId: policy.policy.modeId,
        model: model.model?.id,
        thinkingOptionId: thinking.thinkingOptionId ?? undefined,
        featureValues: features.featureValues,
        providerOptions: sameDriver ? source.config.providerOptions : undefined,
        toolPolicy: source.config.toolPolicy,
        systemPrompt: source.config.systemPrompt,
        mcpServers: source.config.mcpServers,
      },
      droppedFeatureIds: features.dropped,
      droppedThinkingOptionId: thinking.dropped,
      transition,
    },
  };
}
