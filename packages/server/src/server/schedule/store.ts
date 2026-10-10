import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  StoredScheduleSchema,
  type ScheduleTarget,
  type StoredSchedule,
} from "@getpaseo/protocol/schedule/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

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
  private readonly scheduleMutations = new Map<string, Promise<unknown>>();
  private readonly identityMutations = new Map<string, Promise<unknown>>();
  private reportedInvalidFiles = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
    private readonly options: ScheduleMutationOptions = {},
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
        schedules.push(parsed.data);
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

  async update(
    id: string,
    updater: ScheduleUpdater,
    options: ScheduleMutationOptions = this.options,
  ): Promise<StoredSchedule | null> {
    return this.serializeScheduleMutation(id, async () => {
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
          if (updated !== current) await this.write(updated);
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

  async delete(id: string): Promise<void> {
    await this.serializeScheduleMutation(id, async () => {
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
