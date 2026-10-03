export type VoiceSpeakHandler = (params: {
  text: string;
  callerAgentId: string;
  signal?: AbortSignal;
}) => Promise<void>;

export interface VoiceCallerContext {
  childAgentDefaultLabels?: Record<string, string>;
  lockedCwd?: string;
  allowCustomCwd?: boolean;
  enableVoiceTools?: boolean;
  /** Returns a refusal message when the caller may not approve a permission right now. */
  authorizePermissionApproval?: () => string | null;
  /**
   * The caller works for the user rather than owning its work (the voice orchestrator): agents it
   * creates are root agents the user sees, and creation must name a real place instead of
   * defaulting to the caller's own directory.
   */
  actsForUser?: boolean;
}
