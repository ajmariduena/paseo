/** Boot could not settle this agent's switch operation; no loader or sender may touch it. */
export class SwitchRecoveryPendingError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} is waiting for its provider switch to be recovered`);
    this.name = "SwitchRecoveryPendingError";
  }
}
