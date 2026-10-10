/** A resume carried a handle that is no longer the record's active incarnation; reload and retry. */
export class StaleAgentHandleError extends Error {
  constructor(
    readonly agentId: string,
    readonly staleSessionId: string,
    readonly activeSessionId: string | null,
  ) {
    super(`Agent ${agentId} no longer runs on session ${staleSessionId}`);
    this.name = "StaleAgentHandleError";
  }
}
