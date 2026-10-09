import { z } from "zod";

const PersistenceHandleSchema = z.object({
  provider: z.string(),
  sessionId: z.string(),
  nativeHandle: z.any().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const SnapshotCoverageSchema = z.enum(["complete", "truncated", "unavailable"]);

export const ProviderIncarnationSchema = z.object({
  id: z.string(),
  /** Written at allocation, before any turn; a resume is only valid once a turn was accepted. */
  persistence: PersistenceHandleSchema.nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  reason: z.enum(["switch", "uncertain_delivery", "resume_failed"]),
  snapshotId: z.string().nullable(),
  rowCount: z.number().int().nullable(),
  coverage: SnapshotCoverageSchema.nullable(),
  /** First accepted submission on this native session; null means it may still restore fresh. */
  firstAcceptedAt: z.string().nullable().default(null),
  /** A submission whose outcome never settled; continuation and replay must not assume it. */
  unresolvedAttemptId: z.string().nullable().default(null),
});

export const ProviderSegmentSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  incarnations: z.array(ProviderIncarnationSchema),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  handoffId: z.string().nullable(),
  requestedBy: z.enum(["user", "agent"]),
  operationId: z.string(),
});

export const PendingProviderSwitchSchema = z.object({
  operationId: z.string(),
  clientOperationId: z.string(),
  fingerprint: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  requestedAt: z.string(),
  requestedBy: z.enum(["user", "agent"]),
});

export const SwitchOperationPhaseSchema = z.enum([
  "planned",
  "draining",
  "sealed",
  "allocated",
  "committed",
  "done",
  "failed",
]);

export const SwitchOperationResultSchema = z.object({
  targetSegmentId: z.string(),
  targetIncarnationId: z.string(),
  handoffId: z.string().nullable(),
});

export const SwitchOperationSchema = z.object({
  operationId: z.string(),
  clientOperationId: z.string(),
  fingerprint: z.string(),
  phase: SwitchOperationPhaseSchema,
  sourceSegmentId: z.string(),
  targetSegmentId: z.string().nullable(),
  /** Set once `sealed`: the displaced incarnation's snapshot, swept if the operation fails. */
  sealedSnapshotId: z.string().nullable().default(null),
  /** Set once `allocated`: the native session created for the target, orphaned if never committed. */
  allocatedHandle: PersistenceHandleSchema.nullable().default(null),
  result: SwitchOperationResultSchema.nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
});

export type ProviderIncarnation = z.infer<typeof ProviderIncarnationSchema>;
export type ProviderSegment = z.infer<typeof ProviderSegmentSchema>;
export type PendingProviderSwitch = z.infer<typeof PendingProviderSwitchSchema>;
export type SwitchOperation = z.infer<typeof SwitchOperationSchema>;
export type SwitchOperationPhase = z.infer<typeof SwitchOperationPhaseSchema>;
export type SnapshotCoverage = z.infer<typeof SnapshotCoverageSchema>;

/** The segment and incarnation fields a record carries; absent segments mean one implicit segment. */
export interface ProviderSwitchRecordState {
  providerSegments?: ProviderSegment[];
  pendingProviderSwitch?: PendingProviderSwitch | null;
  switchOperations?: SwitchOperation[];
}

export const SWITCH_OPERATIONS_RETAINED = 20;

export const SETTLED_SWITCH_PHASES: ReadonlySet<SwitchOperationPhase> = new Set(["done", "failed"]);

export function activeSegment(state: ProviderSwitchRecordState): ProviderSegment | null {
  const segments = state.providerSegments ?? [];
  return segments.find((segment) => segment.endedAt === null) ?? segments.at(-1) ?? null;
}

export function activeIncarnation(state: ProviderSwitchRecordState): ProviderIncarnation | null {
  const segment = activeSegment(state);
  if (!segment) return null;
  return (
    segment.incarnations.find((incarnation) => incarnation.endedAt === null) ??
    segment.incarnations.at(-1) ??
    null
  );
}

export function hasUnsettledSwitch(state: ProviderSwitchRecordState): boolean {
  if (state.pendingProviderSwitch) return true;
  return (state.switchOperations ?? []).some(
    (operation) => !SETTLED_SWITCH_PHASES.has(operation.phase),
  );
}

/** Keeps the newest operations; older settled ones fall off, unsettled ones never do. */
export function retainSwitchOperations(operations: readonly SwitchOperation[]): SwitchOperation[] {
  const unsettledCount = operations.filter(
    (operation) => !SETTLED_SWITCH_PHASES.has(operation.phase),
  ).length;
  let settledToDrop = Math.max(
    0,
    operations.length - unsettledCount - (SWITCH_OPERATIONS_RETAINED - unsettledCount),
  );
  const kept: SwitchOperation[] = [];
  for (const operation of operations) {
    if (SETTLED_SWITCH_PHASES.has(operation.phase) && settledToDrop > 0) {
      settledToDrop -= 1;
      continue;
    }
    kept.push(operation);
  }
  return kept;
}
