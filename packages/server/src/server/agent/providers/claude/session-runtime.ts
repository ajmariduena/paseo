import path from "node:path";
import { z } from "zod";
import type { AgentPersistenceHandle } from "../../agent-sdk-types.js";

// Host-local artifact provenance, never a portable launch configuration or credential store.
export const ClaudeSessionRuntimeSchema = z.object({
  configDir: z.string().min(1).refine(path.isAbsolute),
  cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type ClaudeSessionRuntime = z.infer<typeof ClaudeSessionRuntimeSchema>;

export function readClaudeSessionRuntime(
  handle: AgentPersistenceHandle | undefined,
): ClaudeSessionRuntime | null {
  const value = handle?.metadata?.claudeRuntime;
  return value === undefined ? null : ClaudeSessionRuntimeSchema.parse(value);
}
