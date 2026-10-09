import type { AgentPromptInput } from "../agent-sdk-types.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";

export interface BudgetInput {
  prompt: AgentPromptInput;
  occupancy: number;
  contextWindow?: number;
  cap?: number;
}

export interface HandoffBudget {
  available: number;
  cap: number;
  contextWindow: number;
  unknownWindow: boolean;
  occupancy: number;
  currentInput: number;
  reserve: number;
}

export class HandoffInputError extends Error {
  constructor(readonly field: string) {
    super(`Invalid handoff input: ${field}`);
    this.name = "HandoffInputError";
  }
}

export function promptCost(prompt: AgentPromptInput): number {
  if (typeof prompt === "string") return Buffer.byteLength(JSON.stringify(prompt));
  const text: string[] = [];
  let images = 0;
  for (const block of prompt) {
    if (block.type === "image") {
      images++;
    } else if (block.type === "text") {
      text.push(block.text);
    } else {
      text.push(renderPromptAttachmentAsText(block));
    }
  }
  return Buffer.byteLength(JSON.stringify(text.join("\n\n"))) + images * 8_192;
}

// Adapted from T3 Code handoffBudget.ts; see LICENSE.t3code.
export function handoffBudget(input: BudgetInput): HandoffBudget {
  const configuredCap = input.cap ?? 16_000;
  const contextWindow = input.contextWindow ?? 128_000;
  if (!Number.isSafeInteger(configuredCap)) throw new HandoffInputError("cap");
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new HandoffInputError("contextWindow");
  }
  if (!Number.isSafeInteger(input.occupancy) || input.occupancy < 0) {
    throw new HandoffInputError("occupancy");
  }
  const cap = Math.max(1_024, Math.min(64_000, configuredCap));
  const currentInput = promptCost(input.prompt);
  const reserve = Math.max(16_000, Math.ceil(contextWindow / 4));
  const remaining = contextWindow - input.occupancy - currentInput - reserve;
  const available = Math.max(0, Math.min(cap, 64_000, remaining));
  return {
    available,
    cap,
    contextWindow,
    unknownWindow: input.contextWindow === undefined,
    occupancy: input.occupancy,
    currentInput,
    reserve,
  };
}
