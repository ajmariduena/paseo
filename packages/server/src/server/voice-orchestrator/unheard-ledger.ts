import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type pino from "pino";

export type UnheardReason = "permission" | "error" | "finished";

export interface UnheardEntry {
  agentId: string;
  reason: UnheardReason;
  at: number;
}

const PRIORITY: Record<UnheardReason, number> = { permission: 0, error: 1, finished: 2 };

const LedgerFileSchema = z.object({
  entries: z.array(
    z.object({
      agentId: z.string(),
      reason: z.enum(["permission", "error", "finished"]),
      at: z.number(),
    }),
  ),
});

export function isUnheardReason(reason: string): reason is UnheardReason {
  return reason === "permission" || reason === "error" || reason === "finished";
}

/** An entry stays until a call confirms it was spoken through, across calls and daemon restarts. */
export class UnheardLedger {
  private readonly entries = new Map<string, UnheardEntry>();
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly options: {
      path: string;
      ttlMs: number;
      logger: pino.Logger;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.options.path, "utf8");
    } catch {
      return;
    }
    const parsed = LedgerFileSchema.safeParse(safeJson(raw));
    if (!parsed.success) return;
    for (const entry of parsed.data.entries) {
      if (!this.isExpired(entry) && !this.entries.has(entry.agentId)) {
        this.entries.set(entry.agentId, entry);
      }
    }
  }

  add(agentId: string, reason: UnheardReason): void {
    const existing = this.entries.get(agentId);
    if (existing && !this.isExpired(existing) && PRIORITY[existing.reason] < PRIORITY[reason]) {
      return;
    }
    this.entries.set(agentId, { agentId, reason, at: this.now() });
    this.persist();
  }

  /** Drops the entry; with a reason, only when it is still about that reason. */
  remove(agentId: string, reason?: UnheardReason): void {
    const existing = this.entries.get(agentId);
    if (!existing || (reason && existing.reason !== reason)) return;
    this.entries.delete(agentId);
    this.persist();
  }

  has(agentId: string): boolean {
    const entry = this.entries.get(agentId);
    return entry !== undefined && !this.isExpired(entry);
  }

  list(): UnheardEntry[] {
    return [...this.entries.values()]
      .filter((entry) => !this.isExpired(entry))
      .sort((left, right) => PRIORITY[left.reason] - PRIORITY[right.reason] || left.at - right.at);
  }

  flushed(): Promise<void> {
    return this.writes;
  }

  private isExpired(entry: UnheardEntry): boolean {
    return this.now() - entry.at > this.options.ttlMs;
  }

  private persist(): void {
    const body = `${JSON.stringify({ entries: this.list() }, null, 2)}\n`;
    this.writes = this.writes
      .then(() => this.write(body))
      .catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Failed to save unheard voice results");
      });
  }

  private async write(body: string): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true });
    await writeFile(this.options.path, body, "utf8");
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
