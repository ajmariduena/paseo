export const COMPACT_COMMAND_TEXT = "/compact";

const COMPACT_COMMAND_NAME = "compact";

export type CompactTiming = "now" | "after-turn";

export interface CompactAvailabilityInput {
  commands: readonly { name: string }[];
  hasUsage: boolean;
}

/** Offered only where typing `/compact` would reach a provider command. */
export function canCompactConversation(input: CompactAvailabilityInput): boolean {
  return input.hasUsage && input.commands.some((command) => command.name === COMPACT_COMMAND_NAME);
}

export function resolveCompactTiming(isAgentRunning: boolean): CompactTiming {
  return isAgentRunning ? "after-turn" : "now";
}
