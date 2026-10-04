import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

const DeliveryStateSchema = z.enum(["pending", "claimed", "acknowledged", "delivered", "disposed"]);
const TaskStatusSchema = z.enum(["running", "completed", "failed", "cancelled", "interrupted"]);

const DelegationTaskSchema = z.object({
  id: z.string(),
  childAgentId: z.string(),
  spawningRunKey: z.string(),
  source: z.enum(["create_agent", "send_agent_prompt"]),
  title: z.string(),
  promptPreview: z.string(),
  completionWake: z.enum(["always", "settled_only"]),
  status: TaskStatusSchema,
  result: z.string().nullable(),
  resultTruncated: z.boolean(),
  completionDelivery: z.object({
    state: DeliveryStateSchema,
    observedByRunKey: z.string().nullable(),
  }),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});

const DeliveryDispatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("started"), runKey: z.string().nullable() }),
]);

const DeliverySchema = z.object({
  generation: z.number().int(),
  messageId: z.string(),
  taskIds: z.array(z.string()),
  dispatch: DeliveryDispatchSchema,
});

const CohortSchema = z.object({
  disposition: z.enum(["open", "stopped", "disposed"]),
  nextGeneration: z.number().int(),
  delivery: DeliverySchema.nullable(),
});

const DelegationFileSchema = z.object({
  version: z.literal(1),
  parentAgentId: z.string(),
  cohorts: z.record(z.string(), CohortSchema),
  tasks: z.record(z.string(), DelegationTaskSchema),
});

const ChildIndexSchema = z.record(z.string(), z.array(z.string()));

export type DelegationTask = z.infer<typeof DelegationTaskSchema>;
export type DelegationTaskStatus = z.infer<typeof TaskStatusSchema>;
export type DelegationDelivery = z.infer<typeof DeliverySchema>;
export type DelegationCohort = z.infer<typeof CohortSchema>;
export type DelegationFile = z.infer<typeof DelegationFileSchema>;
export type TerminalTaskStatus = Exclude<DelegationTaskStatus, "running">;

const FINAL_DELIVERY_STATES = new Set(["acknowledged", "delivered", "disposed"]);
const RESULT_BYTE_LIMIT = 64 * 1024;

export function isDeliveryFinal(task: DelegationTask): boolean {
  return FINAL_DELIVERY_STATES.has(task.completionDelivery.state);
}

/** Identifies one outstanding delivery. Its messageId is the wake message's stable id. */
export interface DeliveryRef {
  cohortKey: string;
  generation: number;
  messageId: string;
}

export interface WakeOffer extends DeliveryRef {
  parentAgentId: string;
}

export interface PlanContext {
  isRunLive(runKey: string): boolean;
  parentArchived: boolean;
}

export interface NewDelegationTask {
  id: string;
  childAgentId: string;
  spawningRunKey: string;
  source: DelegationTask["source"];
  title: string;
  prompt: string;
  completionWake: DelegationTask["completionWake"];
}

export interface TaskTerminal {
  status: TerminalTaskStatus;
  result: string;
  /** False removes the task from wakes, for a child that left its parent. */
  wake: boolean;
}

export interface WakeRunOutcome {
  cancelled: boolean;
}

export function wakeMessageId(
  parentAgentId: string,
  cohortKey: string,
  generation: number,
): string {
  return `wake:${parentAgentId}:${cohortKey}:${generation}`;
}

function capResult(result: string): { result: string; resultTruncated: boolean } {
  const bytes = Buffer.from(result, "utf8");
  if (bytes.byteLength <= RESULT_BYTE_LIMIT) {
    return { result, resultTruncated: false };
  }
  return {
    result: bytes.subarray(0, RESULT_BYTE_LIMIT).toString("utf8"),
    resultTruncated: true,
  };
}

function setDeliveryState(
  task: DelegationTask,
  state: DelegationTask["completionDelivery"]["state"],
  now: string,
): void {
  task.completionDelivery = { ...task.completionDelivery, state };
  task.updatedAt = now;
}

function matchesDelivery(cohort: DelegationCohort | undefined, ref: DeliveryRef): boolean {
  const delivery = cohort?.delivery;
  return (
    delivery != null &&
    delivery.generation === ref.generation &&
    delivery.messageId === ref.messageId
  );
}

/**
 * Port of T3 `planDelegatedCompletionDelivery`: decides whether a terminal task joins the
 * cohort's outstanding wake, waits for a successor, or opens a new wake generation.
 * Mutates `file` and returns the wake to offer, if any.
 */
export function planDelivery(
  file: DelegationFile,
  taskId: string,
  context: PlanContext,
  now: string,
): WakeOffer | null {
  const task = file.tasks[taskId];
  if (!task || isDeliveryFinal(task)) {
    return null;
  }
  const cohortKey = task.spawningRunKey;
  const cohort = file.cohorts[cohortKey];
  if (!cohort || context.parentArchived || cohort.disposition !== "open") {
    setDeliveryState(task, "disposed", now);
    return null;
  }
  if (task.completionWake === "settled_only" && context.isRunLive(cohortKey)) {
    return null;
  }
  const outstanding = cohort.delivery;
  if (outstanding) {
    if (outstanding.dispatch.kind === "started") {
      setDeliveryState(task, "pending", now);
      return null;
    }
    if (!outstanding.taskIds.includes(taskId)) {
      outstanding.taskIds.push(taskId);
    }
    setDeliveryState(task, "claimed", now);
    if (outstanding.dispatch.kind === "queued") {
      return null;
    }
    return { parentAgentId: file.parentAgentId, cohortKey, ...pickRef(outstanding) };
  }
  const generation = cohort.nextGeneration;
  const delivery: DelegationDelivery = {
    generation,
    messageId: wakeMessageId(file.parentAgentId, cohortKey, generation),
    taskIds: [taskId],
    dispatch: { kind: "none" },
  };
  cohort.nextGeneration = generation + 1;
  cohort.delivery = delivery;
  setDeliveryState(task, "claimed", now);
  return { parentAgentId: file.parentAgentId, cohortKey, ...pickRef(delivery) };
}

function pickRef(delivery: DelegationDelivery): Omit<DeliveryRef, "cohortKey"> {
  return { generation: delivery.generation, messageId: delivery.messageId };
}

/** Every terminal task left pending in a cohort goes out together in one successor wake. */
function planSuccessor(
  file: DelegationFile,
  cohortKey: string,
  context: PlanContext,
  now: string,
): WakeOffer | null {
  let offer: WakeOffer | null = null;
  for (const task of Object.values(file.tasks)) {
    const isPendingResult =
      task.spawningRunKey === cohortKey &&
      task.status !== "running" &&
      task.completionDelivery.state === "pending";
    if (isPendingResult) {
      offer = planDelivery(file, task.id, context, now) ?? offer;
    }
  }
  return offer;
}

function releaseUnrendered(
  file: DelegationFile,
  delivery: DelegationDelivery,
  renderedTaskIds: readonly string[],
  now: string,
): void {
  for (const taskId of delivery.taskIds) {
    const task = file.tasks[taskId];
    if (task && !renderedTaskIds.includes(taskId) && !isDeliveryFinal(task)) {
      setDeliveryState(task, "pending", now);
    }
  }
}

function emptyFile(parentAgentId: string): DelegationFile {
  return { version: 1, parentAgentId, cohorts: {}, tasks: {} };
}

/**
 * Durable delegated tasks and wake cohorts, one JSON file per parent agent. Every method is
 * one atomic write of that file, the shape of one SQL transaction.
 */
export class DelegationStore {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  async get(parentAgentId: string): Promise<DelegationFile | null> {
    return await this.read(parentAgentId);
  }

  /** Idempotent on task id. A newer task for the same child supersedes an older pending one. */
  async createTask(
    parentAgentId: string,
    input: NewDelegationTask,
    now: string,
  ): Promise<DelegationTask> {
    const task = await this.mutate(parentAgentId, (file) => {
      const existing = file.tasks[input.id];
      if (existing) {
        return existing;
      }
      for (const older of Object.values(file.tasks)) {
        const superseded =
          older.childAgentId === input.childAgentId &&
          older.status === "running" &&
          !isDeliveryFinal(older);
        if (superseded) {
          setDeliveryState(older, "disposed", now);
        }
      }
      file.cohorts[input.spawningRunKey] ??= {
        disposition: "open",
        nextGeneration: 1,
        delivery: null,
      };
      const created: DelegationTask = {
        id: input.id,
        childAgentId: input.childAgentId,
        spawningRunKey: input.spawningRunKey,
        source: input.source,
        title: input.title,
        promptPreview: input.prompt.slice(0, 500),
        completionWake: input.completionWake,
        status: "running",
        result: null,
        resultTruncated: false,
        completionDelivery: { state: "pending", observedByRunKey: null },
        createdAt: now,
        completedAt: null,
        updatedAt: now,
      };
      file.tasks[input.id] = created;
      return created;
    });
    // The parent file commits first; a missing index entry is recoverable by scanning files.
    await this.mutateIndex((index) => {
      const parents = index[input.childAgentId] ?? [];
      if (!parents.includes(parentAgentId)) {
        index[input.childAgentId] = [...parents, parentAgentId];
      }
    });
    return task;
  }

  /** Records a running task's terminal state and plans its wake in the same write. */
  async finalizeTask(
    parentAgentId: string,
    taskId: string,
    terminal: TaskTerminal,
    context: PlanContext,
    now: string,
  ): Promise<WakeOffer | null> {
    return await this.mutateExisting(parentAgentId, null, (file) => {
      const task = file.tasks[taskId];
      if (!task || task.status !== "running") {
        return null;
      }
      Object.assign(task, capResult(terminal.result), {
        status: terminal.status,
        completedAt: now,
        updatedAt: now,
      });
      if (!terminal.wake && !isDeliveryFinal(task)) {
        setDeliveryState(task, "disposed", now);
      }
      return planDelivery(file, taskId, context, now);
    });
  }

  /** The wake is waiting for the parent's turn; siblings finishing meanwhile join it. */
  async markQueued(parentAgentId: string, ref: DeliveryRef): Promise<boolean> {
    return await this.mutateExisting(parentAgentId, false, (file) => {
      const cohort = file.cohorts[ref.cohortKey];
      if (!cohort?.delivery || !matchesDelivery(cohort, ref)) return false;
      if (cohort.delivery.dispatch.kind !== "none") return false;
      cohort.delivery.dispatch = { kind: "queued" };
      return true;
    });
  }

  /**
   * The wake started as its own turn. Tasks that joined after its text was rendered go back
   * to pending and ride the successor wake.
   */
  async markStarted(
    parentAgentId: string,
    ref: DeliveryRef,
    runKey: string | null,
    renderedTaskIds: readonly string[],
    now: string,
  ): Promise<boolean> {
    return await this.mutateExisting(parentAgentId, false, (file) => {
      const cohort = file.cohorts[ref.cohortKey];
      if (!cohort?.delivery || !matchesDelivery(cohort, ref)) return false;
      if (cohort.delivery.dispatch.kind === "started") return false;
      releaseUnrendered(file, cohort.delivery, renderedTaskIds, now);
      cohort.delivery.taskIds = cohort.delivery.taskIds.filter((id) =>
        renderedTaskIds.includes(id),
      );
      cohort.delivery.dispatch = { kind: "started", runKey };
      return true;
    });
  }

  /**
   * The provider accepted the wake as a steer into a running turn. Acceptance delivers the
   * rendered results; it is not an acknowledgement.
   */
  async acceptDelivery(
    parentAgentId: string,
    ref: DeliveryRef,
    renderedTaskIds: readonly string[],
    context: PlanContext,
    now: string,
  ): Promise<WakeOffer | null> {
    return await this.mutateExisting(parentAgentId, null, (file) => {
      const cohort = file.cohorts[ref.cohortKey];
      if (!cohort?.delivery || !matchesDelivery(cohort, ref)) return null;
      releaseUnrendered(file, cohort.delivery, renderedTaskIds, now);
      for (const taskId of renderedTaskIds) {
        const task = file.tasks[taskId];
        if (task && !isDeliveryFinal(task)) setDeliveryState(task, "delivered", now);
      }
      cohort.delivery = null;
      return planSuccessor(file, ref.cohortKey, context, now);
    });
  }

  /** Port of T3 `finalizeDelegatedCompletionDelivery`, run when a started wake turn ends. */
  async settleWakeRun(
    parentAgentId: string,
    ref: DeliveryRef,
    outcome: WakeRunOutcome,
    context: PlanContext,
    now: string,
  ): Promise<WakeOffer | null> {
    return await this.mutateExisting(parentAgentId, null, (file) => {
      const cohort = file.cohorts[ref.cohortKey];
      if (!cohort?.delivery || !matchesDelivery(cohort, ref)) return null;
      if (cohort.delivery.dispatch.kind !== "started") return null;
      for (const taskId of cohort.delivery.taskIds) {
        const task = file.tasks[taskId];
        if (!task || isDeliveryFinal(task)) continue;
        setDeliveryState(task, outcome.cancelled ? "pending" : "delivered", now);
      }
      cohort.delivery = null;
      return planSuccessor(file, ref.cohortKey, context, now);
    });
  }

  /**
   * The parent read the child's terminal result itself, so its wake is redundant. Removes the
   * results from any wake that has not started; a wake left empty is cleared. Repeats are
   * no-ops. Returns the child's latest terminal task.
   */
  async acknowledgeChildResults(
    parentAgentId: string,
    childAgentId: string,
    observedByRunKey: string | null,
    now: string,
  ): Promise<DelegationTask | null> {
    return await this.mutateExisting(parentAgentId, null, (file) => {
      let latest: DelegationTask | null = null;
      for (const task of Object.values(file.tasks)) {
        if (task.childAgentId !== childAgentId || task.status === "running") continue;
        if (!latest || task.createdAt >= latest.createdAt) latest = task;
        if (isDeliveryFinal(task)) continue;
        task.completionDelivery = { state: "acknowledged", observedByRunKey };
        task.updatedAt = now;
        const delivery = file.cohorts[task.spawningRunKey]?.delivery;
        if (!delivery || delivery.dispatch.kind === "started") continue;
        delivery.taskIds = delivery.taskIds.filter((id) => id !== task.id);
        if (delivery.taskIds.length === 0) {
          file.cohorts[task.spawningRunKey].delivery = null;
        }
      }
      return latest;
    });
  }

  /**
   * Stops every cohort the run spawned or is waking: later results from those children are
   * disposed instead of waking the parent.
   */
  async stopCohortsOfRun(parentAgentId: string, runKey: string, now: string): Promise<void> {
    await this.mutateExisting(parentAgentId, undefined, (file) => {
      for (const [cohortKey, cohort] of Object.entries(file.cohorts)) {
        const dispatch = cohort.delivery?.dispatch;
        const isWakingRun = dispatch?.kind === "started" && dispatch.runKey === runKey;
        if (cohortKey === runKey || isWakingRun) {
          disposeCohort(file, cohortKey, "stopped", now);
        }
      }
    });
  }

  async disposeAll(parentAgentId: string, now: string): Promise<void> {
    await this.mutateExisting(parentAgentId, undefined, (file) => {
      for (const cohortKey of Object.keys(file.cohorts)) {
        disposeCohort(file, cohortKey, "disposed", now);
      }
    });
  }

  private filePath(parentAgentId: string): string {
    return path.join(this.directory, `${parentAgentId}.json`);
  }

  private indexPath(): string {
    return path.join(this.directory, "by-child.json");
  }

  private async read(parentAgentId: string): Promise<DelegationFile | null> {
    const raw = await readJson(this.filePath(parentAgentId));
    return raw === null ? null : DelegationFileSchema.parse(raw);
  }

  private async readIndex(): Promise<z.infer<typeof ChildIndexSchema>> {
    const raw = await readJson(this.indexPath());
    return raw === null ? {} : ChildIndexSchema.parse(raw);
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.tails.set(key, result);
    void result
      .finally(() => {
        if (this.tails.get(key) === result) this.tails.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private mutate<T>(parentAgentId: string, apply: (file: DelegationFile) => T): Promise<T> {
    const filePath = this.filePath(parentAgentId);
    return this.serialize(filePath, async () => {
      const file = (await this.read(parentAgentId)) ?? emptyFile(parentAgentId);
      const result = apply(file);
      await writeJsonFileAtomic(filePath, file);
      return result;
    });
  }

  private mutateExisting<T>(
    parentAgentId: string,
    absent: T,
    apply: (file: DelegationFile) => T,
  ): Promise<T> {
    const filePath = this.filePath(parentAgentId);
    return this.serialize(filePath, async () => {
      const file = await this.read(parentAgentId);
      if (!file) return absent;
      const result = apply(file);
      await writeJsonFileAtomic(filePath, file);
      return result;
    });
  }

  private mutateIndex(apply: (index: z.infer<typeof ChildIndexSchema>) => void): Promise<void> {
    const indexPath = this.indexPath();
    return this.serialize(indexPath, async () => {
      const index = await this.readIndex();
      apply(index);
      await writeJsonFileAtomic(indexPath, index);
    });
  }
}

function disposeCohort(
  file: DelegationFile,
  cohortKey: string,
  disposition: "stopped" | "disposed",
  now: string,
): void {
  const cohort = file.cohorts[cohortKey];
  if (!cohort) return;
  if (cohort.disposition === "open" || disposition === "disposed") {
    cohort.disposition = disposition;
  }
  cohort.delivery = null;
  for (const task of Object.values(file.tasks)) {
    if (task.spawningRunKey === cohortKey && !isDeliveryFinal(task)) {
      setDeliveryState(task, "disposed", now);
    }
  }
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
