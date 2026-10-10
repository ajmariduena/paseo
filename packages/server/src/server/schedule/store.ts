import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "pino";
import {
  StoredScheduleSchema,
  type ScheduleTarget,
  type StoredSchedule,
} from "@getpaseo/protocol/schedule/types";
import { syncFilePublication, writeJsonFileAtomic } from "../atomic-file.js";
import { readBoundedFile, writeJournal } from "../handoff/artifacts.js";
import {
  HANDOFF_SCHEDULE_MAX_BYTES,
  HandoffScheduleIdSchema,
  remapHandoffSchedules,
  scheduleHandoffDigest,
  type InstallHandoffSchedulesInput,
  type HandoffActiveRun,
} from "./handoff.js";

function generateScheduleId(): string {
  return randomBytes(4).toString("hex");
}

type ScheduleUpdater = (schedule: StoredSchedule) => StoredSchedule | Promise<StoredSchedule>;

export interface ScheduleMutation {
  previous: StoredSchedule | null;
  next: StoredSchedule | null;
}

interface ScheduleMutationOptions {
  admitMutation?: (mutation: ScheduleMutation) => Promise<() => void>;
  durable?: boolean;
}

interface PendingSchedulePublication {
  previous: StoredSchedule;
  record: StoredSchedule;
}

interface ScheduleStoreOptions extends ScheduleMutationOptions {
  isVisible?: (id: string) => boolean;
}

interface ScheduleNameTargetUpsert {
  create: () => Omit<StoredSchedule, "id"> | Promise<Omit<StoredSchedule, "id">>;
  update: ScheduleUpdater;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalize(source[key])]),
    );
  }
  return value;
}

function normalizeScheduleName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Schedule name is required");
  }
  return trimmed;
}

function normalizeOptionalScheduleName(name: string | null): string | null {
  if (name === null) {
    return null;
  }
  const trimmed = name.trim();
  return trimmed ? trimmed : null;
}

function targetIdentity(target: ScheduleTarget): unknown {
  if (target.type === "agent") {
    return {
      type: target.type,
      agentId: target.agentId,
    };
  }

  return {
    type: target.type,
    config: target.config,
  };
}

function nameTargetIdentityKey(name: string, target: ScheduleTarget): string {
  return JSON.stringify(
    canonicalize({
      name: normalizeScheduleName(name),
      target: targetIdentity(target),
    }),
  );
}

function matchesNameAndTarget(
  schedule: StoredSchedule,
  name: string,
  target: ScheduleTarget,
): boolean {
  const scheduleName = normalizeOptionalScheduleName(schedule.name);
  return (
    schedule.status !== "completed" &&
    scheduleName !== null &&
    scheduleName === normalizeScheduleName(name) &&
    nameTargetIdentityKey(scheduleName, schedule.target) === nameTargetIdentityKey(name, target)
  );
}

function parseStoredSchedule(
  content: string,
): { success: true; data: StoredSchedule } | { success: false; error: unknown } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { success: false, error };
  }
  return StoredScheduleSchema.safeParse(json);
}

export class ScheduleStore {
  private readonly pendingPublications = new Map<string, PendingSchedulePublication>();
  private readonly scheduleMutations = new Map<string, Promise<unknown>>();
  private readonly identityMutations = new Map<string, Promise<unknown>>();
  private reportedInvalidFiles = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
    private readonly options: ScheduleStoreOptions = {},
  ) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  // The service lists schedules on every tick, so a file that is not a valid schedule is
  // reported when it first appears rather than once per second.
  async list(): Promise<StoredSchedule[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = join(this.dir, entry.name);
          return { filePath, parsed: parseStoredSchedule(await readFile(filePath, "utf-8")) };
        }),
    );
    const schedules: StoredSchedule[] = [];
    const invalidFiles = new Set<string>();
    for (const { filePath, parsed } of files) {
      if (parsed.success) {
        if (this.options.isVisible?.(parsed.data.id) !== false) schedules.push(parsed.data);
        continue;
      }
      invalidFiles.add(filePath);
      if (!this.reportedInvalidFiles.has(filePath)) {
        this.logger.error({ err: parsed.error, filePath }, "Skipping invalid schedule file");
      }
    }
    this.reportedInvalidFiles = invalidFiles;
    return schedules.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    if (this.options.isVisible?.(id) === false) return null;
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return StoredScheduleSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule> {
    const created = StoredScheduleSchema.parse({ ...schedule, id: generateScheduleId() });
    await this.withMutation({
      previous: null,
      next: created,
      operation: () => this.write(created),
    });
    return created;
  }

  async listForHandoff(): Promise<StoredSchedule[]> {
    await this.repairPendingPersistence();
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    if (entries.length > 10_000) throw new Error("Schedule inventory exceeds the handoff limit");
    const records: StoredSchedule[] = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile()) throw new Error("Schedule inventory contains a non-regular record");
      const data = await readBoundedFile(join(this.dir, entry.name), HANDOFF_SCHEDULE_MAX_BYTES);
      bytes += data.length;
      if (bytes > HANDOFF_SCHEDULE_MAX_BYTES)
        throw new Error("Schedule inventory exceeds the handoff byte limit");
      const record = StoredScheduleSchema.parse(JSON.parse(data.toString("utf8")));
      HandoffScheduleIdSchema.parse(record.id);
      if (entry.name !== `${record.id}.json`)
        throw new Error("Schedule identity differs from its file");
      if (this.options.isVisible?.(record.id) !== false) records.push(record);
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The service must hold the matching durable source fence before entering this path. */
  async pauseForHandoff(input: {
    id: string;
    digest: string;
    pausedAt: string;
    activeRun?: HandoffActiveRun;
  }): Promise<StoredSchedule> {
    HandoffScheduleIdSchema.parse(input.id);
    return this.serializeScheduleMutation(input.id, async () => {
      await this.publishPending(input.id);
      if (this.options.isVisible?.(input.id) === false)
        throw new Error("Schedule is not yet active on this host");
      const bytes = await readBoundedFile(this.filePath(input.id), HANDOFF_SCHEDULE_MAX_BYTES);
      const record = StoredScheduleSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (record.id !== input.id || scheduleHandoffDigest(record, input.activeRun) !== input.digest)
        throw new Error("Scheduled automation changed after handoff review");
      if (record.runs.some((run) => run.status === "running"))
        throw new Error("A scheduled run is still active; stop or finish it before handoff");
      const paused: StoredSchedule =
        record.status === "active"
          ? {
              ...record,
              status: "paused",
              nextRunAt: null,
              pausedAt: input.pausedAt,
              updatedAt: input.pausedAt,
            }
          : record;
      if (paused !== record) await this.write(paused);
      // Retry the acknowledgement even when the prior rename already survived.
      await syncFilePublication(this.filePath(record.id), dirname(this.dir));
      return paused;
    });
  }

  async installHandoffSchedules(input: InstallHandoffSchedulesInput): Promise<void> {
    const records = remapHandoffSchedules(input);
    await this.ensureDir();
    for (const record of records) {
      await this.serializeScheduleMutation(record.id, async () => {
        const file = this.filePath(record.id);
        const temporary = join(this.dir, `.handoff-${randomUUID()}.tmp`);
        try {
          await writeJournal(temporary, record);
          try {
            await link(temporary, file);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
              throw error;
            const bytes = await readBoundedFile(file, HANDOFF_SCHEDULE_MAX_BYTES);
            const existing = StoredScheduleSchema.parse(JSON.parse(bytes.toString("utf8")));
            if (!isDeepStrictEqual(existing, record))
              throw new Error("Destination schedule identity is already in use", { cause: error });
          }
          await syncFilePublication(file, dirname(this.dir));
        } finally {
          await rm(temporary, { force: true });
        }
      });
    }
  }

  async update(
    id: string,
    updater: ScheduleUpdater,
    options: ScheduleMutationOptions = this.options,
  ): Promise<StoredSchedule | null> {
    return this.serializeScheduleMutation(id, async () => {
      await this.publishPending(id);
      const current = await this.get(id);
      if (!current) {
        return null;
      }
      const next = await updater(current);
      if (next.id !== id) {
        throw new Error(`Schedule update cannot change id: ${id}`);
      }
      const updated = next === current ? current : StoredScheduleSchema.parse(next);
      await this.withMutation({
        previous: current,
        next: updated,
        options,
        operation: async () => {
          if (updated === current) return;
          if (options.durable) {
            this.pendingPublications.set(id, {
              previous: structuredClone(current),
              // Match JSON's omission of optional undefined values when checking
              // a renamed file after its synchronization acknowledgement failed.
              record: StoredScheduleSchema.parse(JSON.parse(JSON.stringify(updated))),
            });
            await this.publishPending(id);
          } else {
            await this.write(updated);
          }
        },
      });
      return updated;
    });
  }

  async upsertByNameAndTarget(
    name: string,
    target: ScheduleTarget,
    options: ScheduleNameTargetUpsert,
  ): Promise<StoredSchedule> {
    const identity = nameTargetIdentityKey(name, target);
    return this.serializeIdentityMutation(identity, async () => {
      while (true) {
        const existing = (await this.list()).find((schedule) =>
          matchesNameAndTarget(schedule, name, target),
        );
        if (!existing) {
          const created = StoredScheduleSchema.parse({
            ...(await options.create()),
            id: generateScheduleId(),
          });
          if (!matchesNameAndTarget(created, name, target)) {
            throw new Error("Created schedule does not match requested identity");
          }
          await this.withMutation({
            previous: null,
            next: created,
            operation: () => this.write(created),
          });
          return created;
        }

        const updated = await this.updateMatchedSchedule(existing.id, name, target, options.update);
        if (updated) {
          return updated;
        }
      }
    });
  }

  private async write(schedule: StoredSchedule): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(schedule.id), schedule);
  }

  async repairPendingPersistence(id?: string): Promise<void> {
    const ids = id === undefined ? [...this.pendingPublications.keys()] : [id];
    await Promise.all(
      ids.map((key) => this.serializeScheduleMutation(key, () => this.publishPending(key))),
    );
  }

  private async publishPending(id: string): Promise<void> {
    const pending = this.pendingPublications.get(id);
    if (!pending) return;
    const limit = Math.max(
      Buffer.byteLength(JSON.stringify(pending.previous, null, 2)),
      Buffer.byteLength(JSON.stringify(pending.record, null, 2)),
    );
    const bytes = await readBoundedFile(this.filePath(id), limit);
    const current = StoredScheduleSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (!isDeepStrictEqual(current, pending.record)) {
      if (!isDeepStrictEqual(current, pending.previous))
        throw new Error("Schedule changed while its completed outcome awaited persistence");
      await this.write(pending.record);
    }
    // Windows keeps ordinary atomic-write semantics; source handoff remains disabled there.
    if (process.platform !== "win32")
      await syncFilePublication(this.filePath(id), dirname(this.dir));
    this.pendingPublications.delete(id);
  }

  async delete(id: string): Promise<void> {
    await this.serializeScheduleMutation(id, async () => {
      await this.publishPending(id);
      const current = await this.get(id);
      if (!current) return;
      await this.withMutation({
        previous: current,
        next: null,
        operation: () => rm(this.filePath(id), { force: true }),
      });
    });
  }

  private async withMutation(
    input: ScheduleMutation & {
      options?: ScheduleMutationOptions;
      operation: () => Promise<void>;
    },
  ): Promise<void> {
    const options = input.options ?? this.options;
    const release = await options.admitMutation?.({ previous: input.previous, next: input.next });
    try {
      await input.operation();
    } finally {
      release?.();
    }
  }

  private async serializeScheduleMutation<T>(
    scheduleId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.scheduleMutations, scheduleId, mutation);
  }

  private async serializeIdentityMutation<T>(
    identity: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.identityMutations, identity, mutation);
  }

  private async serializeMutation<T>(
    promises: Map<string, Promise<unknown>>,
    key: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = promises.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    promises.set(key, next);
    try {
      return await next;
    } finally {
      if (promises.get(key) === next) {
        promises.delete(key);
      }
    }
  }

  private async updateMatchedSchedule(
    id: string,
    name: string,
    target: ScheduleTarget,
    updater: ScheduleUpdater,
  ): Promise<StoredSchedule | null> {
    return this.serializeScheduleMutation(id, async () => {
      await this.publishPending(id);
      const current = await this.get(id);
      if (!current || !matchesNameAndTarget(current, name, target)) {
        return null;
      }
      const next = await updater(current);
      if (next.id !== id) {
        throw new Error(`Schedule update cannot change id: ${id}`);
      }
      const updated = StoredScheduleSchema.parse(next);
      if (!matchesNameAndTarget(updated, name, target)) {
        throw new Error("Updated schedule does not match requested identity");
      }
      await this.withMutation({
        previous: current,
        next: updated,
        operation: () => this.write(updated),
      });
      return updated;
    });
  }
}
