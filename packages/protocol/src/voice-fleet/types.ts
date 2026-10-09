import { z } from "zod";

/** What one host knows about one of its agents, phrased for a voice assistant. */
export const VoiceFleetAgentSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  workspaceId: z.string().nullable(),
  workspace: z.string(),
  projectId: z.string().nullable().optional(),
  provider: z.string(),
  /** working | waiting_permission | failed | finished_unreviewed | idle | initializing */
  status: z.string(),
  /** How long the agent has been in this status when the digest was built. */
  statusForMs: z.number().optional(),
  /** The latest request the user gave it. */
  task: z.string().nullable().optional(),
  /** What it is doing right now: its current todo step or latest progress note. */
  now: z.string().nullable().optional(),
  /** Todo progress, e.g. "step 3 of 7". */
  progress: z.string().nullable().optional(),
  /** Counted tool work since its latest request, e.g. "edited 4 files, ran 3 commands". */
  activity: z.string().nullable().optional(),
  /** What blocks it: a pending permission or an error. */
  blocker: z.string().nullable().optional(),
  /** The pending permission request the blocker describes, so a spoken yes answers that one. */
  permissionId: z.string().nullable().optional(),
  /** Its latest message, speakable, when the run settled. */
  outcome: z.string().nullable().optional(),
  /** A model-written summary of where it stands, when the host has one. */
  summary: z.string().nullable().optional(),
  /** A result the user has not heard yet. */
  unheard: z.boolean().optional(),
  updatedAt: z.string(),
});

export const VoiceFleetWorkspaceSchema = z.object({
  workspaceId: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  kind: z.string(),
  branch: z.string().nullable().optional(),
  cwd: z.string(),
});

export const VoiceFleetProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  rootPath: z.string(),
});

/** An open session that is not in `agents`: older or not loaded. */
export const VoiceFleetSessionSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  workspace: z.string(),
  lastActivityAt: z.string(),
});

/** The host's own load, so "how is the mini doing" needs no round trip. */
export const VoiceFleetHostHealthSchema = z.object({
  cpuPercent: z.number().nullable(),
  memoryPercent: z.number().nullable(),
  memoryTotalBytes: z.number(),
  memoryPressure: z.string().nullable(),
  diskFreeBytes: z.number().nullable(),
  busiest: z.array(z.string()),
  uptimeHours: z.number(),
});

export const VoiceFleetDigestSchema = z.object({
  generatedAt: z.string(),
  health: VoiceFleetHostHealthSchema.nullable().optional(),
  agents: z.array(VoiceFleetAgentSchema),
  workspaces: z.array(VoiceFleetWorkspaceSchema),
  projects: z.array(VoiceFleetProjectSchema),
  sessions: z.array(VoiceFleetSessionSchema),
});

/** Another host as the phone sees it, forwarded to the host running the call. */
export const VoiceFleetHostStateSchema = z.object({
  serverId: z.string(),
  label: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable().optional(),
  /** Whether the host runs voice tools, so the call can act on it through the phone. */
  supportsTools: z.boolean(),
  digest: VoiceFleetDigestSchema.nullable(),
});

export const VoiceToolResultSchema = z.object({
  ok: z.boolean(),
  /** Facts for the voice model to say, plain text. */
  text: z.string(),
  /** Longer material the call's router may summarize before it is said. */
  detail: z.string().nullable().optional(),
});

export type VoiceFleetAgent = z.infer<typeof VoiceFleetAgentSchema>;
export type VoiceFleetWorkspace = z.infer<typeof VoiceFleetWorkspaceSchema>;
export type VoiceFleetProject = z.infer<typeof VoiceFleetProjectSchema>;
export type VoiceFleetSession = z.infer<typeof VoiceFleetSessionSchema>;
export type VoiceFleetDigest = z.infer<typeof VoiceFleetDigestSchema>;
export type VoiceFleetHostHealth = z.infer<typeof VoiceFleetHostHealthSchema>;
export type VoiceFleetHostState = z.infer<typeof VoiceFleetHostStateSchema>;
export type VoiceToolResult = z.infer<typeof VoiceToolResultSchema>;
