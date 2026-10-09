import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../../atomic-file.js";
import type { HandoffBudget } from "../context-handoff/budget.js";
import type { HandoffCoverage, RenderedHandoffItem } from "../context-handoff/handoff.js";
import type { HandoffProvenance } from "../context-handoff/types.js";
import { isNotFound, listJsonNames, readJson } from "./snapshot-store.js";

const DeliverySchema = z.object({
  state: z.enum(["unsent", "accepted", "unknown"]),
  /** The submission attempt the envelope was sent under; null while unsent. */
  attemptId: z.string().nullable(),
  updatedAt: z.string(),
});

const HandoffFileSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  agentId: z.string(),
  fromSegmentId: z.string(),
  toSegmentId: z.string(),
  toIncarnationId: z.string(),
  items: z.array(z.custom<RenderedHandoffItem>((value) => typeof value === "object")),
  omittedItems: z.array(z.custom<HandoffProvenance>((value) => typeof value === "object")),
  coverage: z.custom<HandoffCoverage>((value) => typeof value === "object"),
  budget: z.custom<HandoffBudget>((value) => typeof value === "object"),
  cost: z.number(),
  delivery: DeliverySchema,
  createdAt: z.string(),
});

export type HandoffFile = z.infer<typeof HandoffFileSchema>;
export type HandoffDelivery = z.infer<typeof DeliverySchema>;

export class HandoffAlreadyExistsError extends Error {
  constructor(
    readonly agentId: string,
    readonly handoffId: string,
  ) {
    super(`Handoff ${handoffId} of agent ${agentId} already exists`);
    this.name = "HandoffAlreadyExistsError";
  }
}

/**
 * Rendered handoffs with provenance: `{directory}/{agentId}/{handoffId}.json`. The items are
 * copies, so "Ver contexto" survives a restart that renumbers the live timeline. Only the
 * delivery state changes after creation, through one serialized atomic rewrite.
 */
export class HandoffStore {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  async create(file: Omit<HandoffFile, "version">): Promise<HandoffFile> {
    const record: HandoffFile = { version: 1, ...file };
    return await this.serialize(file.agentId, async () => {
      if ((await readJson(this.filePath(file.agentId, file.id))) !== null) {
        throw new HandoffAlreadyExistsError(file.agentId, file.id);
      }
      await writeJsonFileAtomic(this.filePath(file.agentId, file.id), record);
      return record;
    });
  }

  async read(agentId: string, handoffId: string): Promise<HandoffFile | null> {
    const raw = await readJson(this.filePath(agentId, handoffId));
    return raw === null ? null : HandoffFileSchema.parse(raw);
  }

  async updateDelivery(
    agentId: string,
    handoffId: string,
    delivery: HandoffDelivery,
  ): Promise<HandoffFile | null> {
    return await this.serialize(agentId, async () => {
      const current = await this.read(agentId, handoffId);
      if (!current) return null;
      const next = { ...current, delivery };
      await writeJsonFileAtomic(this.filePath(agentId, handoffId), next);
      return next;
    });
  }

  async list(agentId: string): Promise<string[]> {
    return (await listJsonNames(path.join(this.directory, agentId))).sort();
  }

  async listAgents(): Promise<string[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async delete(agentId: string, handoffId: string): Promise<void> {
    await rm(this.filePath(agentId, handoffId), { force: true });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await rm(path.join(this.directory, agentId), { recursive: true, force: true });
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

  private filePath(agentId: string, handoffId: string): string {
    return path.join(this.directory, agentId, `${handoffId}.json`);
  }
}
