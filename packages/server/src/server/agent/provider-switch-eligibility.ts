import type { AgentRuntimeHold, AgentSession } from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";

export type ProviderSwitchBlocker =
  | { kind: "initializing" }
  | { kind: "turn_active"; turnId: string | null }
  | { kind: "run_in_flight" }
  | { kind: "replacement_reserved" }
  | { kind: "permissions_pending"; count: number }
  | { kind: "permission_responses_in_flight"; count: number }
  | { kind: "out_of_band_in_flight" }
  | { kind: "provider_subagents_running"; count: number }
  | { kind: "runtime_release_unproven"; state: "pending" | "failed" }
  | { kind: "provider_runtime_hold"; hold: AgentRuntimeHold }
  | { kind: "provider_background_work" }
  | { kind: "provider_background_unverified"; reason: string };

/** The work-related facts about a live agent. Idle-eviction policy and handles are not among them. */
export interface ProviderSwitchWorkFacts {
  lifecycle: ManagedAgent["lifecycle"];
  activeForegroundTurnId: string | null;
  activeTurnId: string | null;
  pendingReplacement: boolean;
  pendingPermissionCount: number;
  inFlightPermissionResponseCount: number;
  hasRun: boolean;
  hasInFlightOutOfBand: boolean;
  runningProviderSubagentCount: number;
  /** `held`: the runtime is owned normally. A close in flight or one that failed is not a release. */
  runtimeRelease: "held" | "pending" | "failed";
}

export interface ProviderSwitchEligibilityOptions {
  /**
   * The operation that reserved the replacement (an acknowledged interrupt inside
   * `replaceAgentRun`) may switch while `pendingReplacement` still holds the agent busy.
   */
  ownsReplacementReservation?: boolean;
}

export function collectProviderSwitchWorkBlockers(
  facts: ProviderSwitchWorkFacts,
  options: ProviderSwitchEligibilityOptions = {},
): ProviderSwitchBlocker[] {
  const blockers: ProviderSwitchBlocker[] = [];
  const holdsReservation = options.ownsReplacementReservation === true && facts.pendingReplacement;
  const turnId = facts.activeForegroundTurnId ?? facts.activeTurnId;
  if (facts.lifecycle === "initializing") {
    blockers.push({ kind: "initializing" });
  }
  if (turnId !== null || (facts.lifecycle === "running" && !holdsReservation)) {
    blockers.push({ kind: "turn_active", turnId });
  }
  if (facts.hasRun) {
    blockers.push({ kind: "run_in_flight" });
  }
  if (facts.pendingReplacement && !holdsReservation) {
    blockers.push({ kind: "replacement_reserved" });
  }
  if (facts.pendingPermissionCount > 0) {
    blockers.push({ kind: "permissions_pending", count: facts.pendingPermissionCount });
  }
  if (facts.inFlightPermissionResponseCount > 0) {
    blockers.push({
      kind: "permission_responses_in_flight",
      count: facts.inFlightPermissionResponseCount,
    });
  }
  if (facts.hasInFlightOutOfBand) {
    blockers.push({ kind: "out_of_band_in_flight" });
  }
  if (facts.runningProviderSubagentCount > 0) {
    blockers.push({
      kind: "provider_subagents_running",
      count: facts.runningProviderSubagentCount,
    });
  }
  if (facts.runtimeRelease !== "held") {
    blockers.push({ kind: "runtime_release_unproven", state: facts.runtimeRelease });
  }
  return blockers;
}

/**
 * The provider is asked only once the manager-side facts are quiet, and only when it can answer.
 * A provider without a probe has nothing depending on its runtime. Typed holds are preferred
 * over the boolean probe because they say whether the hold ends on its own.
 */
export async function collectProviderSwitchBlockers(
  facts: ProviderSwitchWorkFacts,
  session: Pick<AgentSession, "canEvictIdleBackend" | "describeRuntimeHolds"> | null,
  options: ProviderSwitchEligibilityOptions = {},
): Promise<ProviderSwitchBlocker[]> {
  const blockers = collectProviderSwitchWorkBlockers(facts, options);
  if (blockers.length > 0 || !session) {
    return blockers;
  }
  try {
    if (session.describeRuntimeHolds) {
      for (const hold of await session.describeRuntimeHolds()) {
        blockers.push({ kind: "provider_runtime_hold", hold });
      }
    } else if (session.canEvictIdleBackend && !(await session.canEvictIdleBackend())) {
      blockers.push({ kind: "provider_background_work" });
    }
  } catch (error) {
    blockers.push({
      kind: "provider_background_unverified",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return blockers;
}

/** Whether the blocker ends on its own, so a caller may wait for it instead of refusing. */
export function isWaitableProviderSwitchBlocker(blocker: ProviderSwitchBlocker): boolean {
  switch (blocker.kind) {
    case "runtime_release_unproven":
      return blocker.state === "pending";
    case "provider_runtime_hold":
      return blocker.hold.kind === "background_work";
    case "provider_background_work":
    case "provider_background_unverified":
      return false;
    default:
      return true;
  }
}
