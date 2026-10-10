import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  StoredScheduleSchema,
  ScheduleTargetSchema,
  ScheduleRunSchema,
  type StoredSchedule,
} from "@getpaseo/protocol/schedule/types";
import {
  HandoffScheduleReviewSchema,
  type HandoffScheduleReview,
} from "@getpaseo/protocol/handoff-control";
import { readBoundedFile } from "../handoff/artifacts.js";
import { validateScheduleCadence } from "./cron.js";

export const HANDOFF_SCHEDULE_MAX_BYTES = 32 * 1024 * 1024;
export const HANDOFF_SCHEDULE_MAX_COUNT = 1000;
export const HandoffScheduleIdSchema = z.string().regex(/^(?:[a-f0-9]{8}|[a-f0-9]{32})$/);

const PortableNewAgentConfigSchema = ScheduleTargetSchema.options[1].shape.config.pick({
  provider: true,
  model: true,
  thinkingOptionId: true,
  title: true,
  archiveOnFinish: true,
  isolation: true,
  systemPrompt: true,
});
const PortableScheduleSchema = StoredScheduleSchema.omit({ target: true }).extend({
  id: HandoffScheduleIdSchema,
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["paused", "completed"]),
  nextRunAt: z.null(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  lastRunAt: z.string().datetime({ offset: true }).nullable(),
  pausedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  runs: z.array(
    ScheduleRunSchema.extend({
      scheduledFor: z.string().datetime({ offset: true }),
      startedAt: z.string().datetime({ offset: true }),
      endedAt: z.string().datetime({ offset: true }).nullable(),
    }),
  ),
  target: z.discriminatedUnion("type", [
    ScheduleTargetSchema.options[0],
    z.object({
      type: z.literal("new-agent"),
      relativeCwd: z.string().min(1).max(8192),
      config: PortableNewAgentConfigSchema,
    }),
  ]),
});
const HandoffSchedulesSchema = z.object({
  version: z.literal(1),
  schedules: z.array(PortableScheduleSchema).max(HANDOFF_SCHEDULE_MAX_COUNT),
});
export type HandoffSchedules = z.infer<typeof HandoffSchedulesSchema>;

export function handoffScheduleId(reservationId: string, sourceId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([reservationId, sourceId]))
    .digest("hex")
    .slice(0, 32);
}

function assertRelativeCwd(cwd: string): void {
  if (cwd === ".") return;
  if (
    path.posix.isAbsolute(cwd) ||
    path.win32.isAbsolute(cwd) ||
    cwd.includes("\\") ||
    cwd.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\0"))
  )
    throw new Error("Schedule directory must remain inside the transferred workspace");
}

export type HandoffActiveRun = NonNullable<HandoffScheduleReview["activeRun"]>;

export function scheduleHandoffDigest(
  record: StoredSchedule,
  activeRun?: HandoffActiveRun,
): string {
  if (activeRun) {
    const run = record.runs.find((entry) => entry.id === activeRun.id);
    if (
      !run ||
      record.runs.filter((entry) => entry.id === activeRun.id).length !== 1 ||
      !run.agentId ||
      (record.target.type === "agent" && run.agentId !== record.target.agentId)
    )
      throw new Error("The reviewed scheduled run execution changed");
    const ended = run.status !== "running";
    if (
      (ended && (!run.endedAt || record.lastRunAt !== run.endedAt)) ||
      (!ended &&
        (record.lastRunAt !== activeRun.previousLastRunAt || record.status === "completed"))
    )
      throw new Error("The reviewed scheduled run outcome is inconsistent");
  }
  // Pause and the reviewed run's terminal result may change during preparation.
  // Bind its identity, prior history and definition; release separately checks the full capture.
  const canonical = StoredScheduleSchema.parse({
    ...record,
    status: !activeRun && record.status === "completed" ? "completed" : "paused",
    nextRunAt: null,
    pausedAt: null,
    updatedAt: record.createdAt,
    lastRunAt: activeRun ? activeRun.previousLastRunAt : record.lastRunAt,
    runs: record.runs.map((run) =>
      run.id === activeRun?.id
        ? { ...run, status: "running", endedAt: null, output: null, error: null }
        : run,
    ),
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function reviewScheduleForHandoff(
  record: StoredSchedule,
  activeRun?: HandoffActiveRun,
): HandoffScheduleReview {
  const omittedSettings: string[] = [];
  let omittedMcpServers: string[] = [];
  if (record.target.type === "new-agent") {
    const config = record.target.config;
    if (config.modeId !== undefined) omittedSettings.push("modeId");
    if (config.providerOptions !== undefined) omittedSettings.push("providerOptions");
    if (config.featureValues !== undefined) omittedSettings.push("featureValues");
    omittedMcpServers = Object.keys(config.mcpServers ?? {}).sort();
  }
  const cadence =
    record.cadence.type === "cron"
      ? `${record.cadence.expression} (${record.cadence.timezone ?? "UTC"})`
      : `${record.cadence.everyMs} ms`;
  return HandoffScheduleReviewSchema.parse({
    id: record.id,
    name: record.name,
    status: record.status,
    kind: record.target.type === "agent" ? "heartbeat" : "schedule",
    cadence,
    digest: scheduleHandoffDigest(record, activeRun),
    runCount: record.runs.length,
    ...(activeRun ? { activeRun } : {}),
    omittedSettings,
    omittedMcpServers,
  });
}

interface HandoffScheduleCaptureInput {
  records: StoredSchedule[];
  relativeCwds: ReadonlyMap<string, string>;
  reviews?: HandoffScheduleReview[];
}

function projectHandoffSchedules(input: HandoffScheduleCaptureInput): HandoffSchedules {
  return HandoffSchedulesSchema.parse({
    version: 1,
    schedules: input.records.map((record) => ({
      ...record,
      reviewDigest: scheduleHandoffDigest(
        record,
        input.reviews?.find((review) => review.id === record.id)?.activeRun,
      ),
      target:
        record.target.type === "agent"
          ? record.target
          : {
              type: "new-agent",
              relativeCwd: input.relativeCwds.get(record.id),
              config: PortableNewAgentConfigSchema.parse(record.target.config),
            },
    })),
  });
}

export function captureHandoffSchedules(input: HandoffScheduleCaptureInput): HandoffSchedules {
  return parseHandoffSchedules(projectHandoffSchedules(input));
}

export function estimateHandoffSchedules(input: HandoffScheduleCaptureInput): number {
  // An active run has no final output yet; only capture may publish a portable snapshot.
  const bytes = Buffer.byteLength(JSON.stringify(projectHandoffSchedules(input)));
  if (bytes > HANDOFF_SCHEDULE_MAX_BYTES)
    throw new Error("Scheduled automation exceeds the handoff byte limit");
  return bytes;
}

export function parseHandoffSchedules(value: unknown): HandoffSchedules {
  const snapshot = HandoffSchedulesSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(value)) > HANDOFF_SCHEDULE_MAX_BYTES)
    throw new Error("Scheduled automation exceeds the handoff byte limit");
  const ids = new Set<string>();
  for (const schedule of snapshot.schedules) {
    validateScheduleCadence(schedule.cadence);
    if (ids.has(schedule.id)) throw new Error("Duplicate schedule in handoff");
    ids.add(schedule.id);
    if (schedule.runs.some((run) => run.status === "running"))
      throw new Error("A scheduled run is still active; stop or finish it before handoff");
    if (schedule.target.type === "new-agent") assertRelativeCwd(schedule.target.relativeCwd);
  }
  return snapshot;
}

export async function readHandoffSchedules(file: string): Promise<HandoffSchedules> {
  const bytes = await readBoundedFile(file, HANDOFF_SCHEDULE_MAX_BYTES);
  return parseHandoffSchedules(JSON.parse(bytes.toString("utf8")));
}

export interface InstallHandoffSchedulesInput {
  snapshot: HandoffSchedules;
  reservationId: string;
  sourceServerId: string;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  destinationCwd: string;
  activationAt: string;
  agentMappings: ReadonlyMap<string, string>;
}

export function remapHandoffSchedules(input: InstallHandoffSchedulesInput): StoredSchedule[] {
  const snapshot = parseHandoffSchedules(input.snapshot);
  return snapshot.schedules.map((schedule) => {
    let target: StoredSchedule["target"];
    if (schedule.target.type === "agent") {
      const agentId = input.agentMappings.get(schedule.target.agentId);
      if (!agentId) throw new Error("Heartbeat target is outside the transferred conversations");
      target = { type: "agent", agentId };
    } else {
      target = {
        type: "new-agent",
        config: {
          ...schedule.target.config,
          cwd: path.resolve(input.destinationCwd, schedule.target.relativeCwd),
        },
      };
    }
    return StoredScheduleSchema.parse({
      ...schedule,
      id: handoffScheduleId(input.reservationId, schedule.id),
      target,
      updatedAt: input.activationAt,
      pausedAt: schedule.status === "paused" ? input.activationAt : schedule.pausedAt,
      runs: schedule.runs.map((run) => ({
        ...run,
        agentId: run.agentId ? (input.agentMappings.get(run.agentId) ?? null) : null,
        workspaceId:
          run.workspaceId === input.sourceWorkspaceId ? input.destinationWorkspaceId : null,
        origin: run.origin ?? {
          serverId: input.sourceServerId,
          scheduleId: schedule.id,
          agentId: run.agentId,
          workspaceId: run.workspaceId ?? null,
        },
      })),
    });
  });
}
