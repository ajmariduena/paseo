import type { PaseoToolAnnotations } from "./types.js";

export const READ_ONLY_TOOL_ANNOTATIONS: PaseoToolAnnotations = { readOnlyHint: true };

/**
 * Paseo tools that only read state, so providers run them without a permission prompt in every
 * mode. Must match the catalog tools annotated `readOnlyHint: true`.
 */
export const PASEO_READ_ONLY_TOOL_NAMES: readonly string[] = [
  "get_orchestration_capabilities",
  "list_agents",
  "get_agent_status",
  "get_agent_activity",
  "wait_for_agent",
  "list_pending_permissions",
  "list_workspaces",
  "list_workspace_scripts",
  "list_terminals",
  "capture_terminal",
  "list_providers",
  "list_models",
  "list_profiles",
  "inspect_provider",
  "list_schedules",
  "inspect_schedule",
  "schedule_logs",
];
