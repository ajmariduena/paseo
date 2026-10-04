export interface LiveActivityNative {
  isEnabled(): boolean;
  isRunning(): boolean;
  start(title: string, stateJson: string, staleAfterSeconds: number): Promise<void>;
  update(stateJson: string, staleAfterSeconds: number): Promise<void>;
  /** An empty state ends the activity without a final update. */
  end(stateJson: string, dismissAfterSeconds: number): Promise<void>;
}
