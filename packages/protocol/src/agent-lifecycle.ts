export const AGENT_LIFECYCLE_STATUSES = [
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
] as const;

export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];

export const AGENT_TURN_OUTCOMES = ["completed", "failed", "canceled"] as const;

export type AgentTurnOutcome = (typeof AGENT_TURN_OUTCOMES)[number];
