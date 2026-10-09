import { describe, expect, it } from "vitest";
import { HandoffInputError, handoffBudget, promptCost } from "./budget.js";
import type { AgentPromptInput } from "../agent-sdk-types.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";

describe("handoff budget (T3 golden cases)", () => {
  it("subtracts occupancy and serialized input, rounds reserve and clamps at zero", () => {
    expect(handoffBudget({ prompt: "Continue", occupancy: 8_000, contextWindow: 32_000 })).toEqual({
      available: 7_990,
      cap: 16_000,
      contextWindow: 32_000,
      unknownWindow: false,
      occupancy: 8_000,
      currentInput: 10,
      reserve: 16_000,
    });
    expect(
      handoffBudget({ prompt: "", occupancy: 0, contextWindow: 64_001, cap: 64_000 }).reserve,
    ).toBe(16_001);
    expect(
      handoffBudget({ prompt: "界".repeat(30_000), occupancy: 0, contextWindow: 32_000 }).available,
    ).toBe(0);
  });

  it.each([100_000, 10 * 1024 * 1024])(
    "reserves 8192 per image independently of encoded size %i",
    (size) => {
      const image = { type: "image" as const, mimeType: "image/png", data: "x".repeat(size) };
      const prompt: AgentPromptInput = [{ type: "text", text: "Continue" }, image];
      expect(handoffBudget({ prompt, occupancy: 0, contextWindow: 32_000 }).available).toBe(7_798);
      expect(
        handoffBudget({ prompt: [...prompt, image], occupancy: 0, contextWindow: 32_000 })
          .available,
      ).toBe(0);
      expect(
        handoffBudget({
          prompt: [{ type: "text", text: "x".repeat(70_000) }, image],
          occupancy: 0,
          contextWindow: 1_000_000,
          cap: 64_000,
        }).available,
      ).toBe(64_000);
    },
  );

  it("records unknown window fallback and clamps configured cap", () => {
    expect(handoffBudget({ prompt: "", occupancy: 0 }).contextWindow).toBe(128_000);
    expect(handoffBudget({ prompt: "", occupancy: 0 }).unknownWindow).toBe(true);
    expect(handoffBudget({ prompt: "", occupancy: 0, cap: -1 }).available).toBe(1_024);
    expect(handoffBudget({ prompt: "", occupancy: 0, cap: 1_000_000 }).available).toBe(64_000);
    expect(handoffBudget({ prompt: "", occupancy: 120_000 }).available).toBe(0);
  });

  it.each([0, 1, 8, 10, 16])(
    "budgets image batches of %i against known and unknown windows",
    (count) => {
      const prompt: AgentPromptInput = Array.from({ length: count }, () => ({
        type: "image",
        mimeType: "image/png",
        data: "encoded",
      }));
      const expected = Math.max(0, Math.min(16_000, 128_000 - 32_000 - 2 - count * 8_192));
      expect(handoffBudget({ prompt, occupancy: 0 }).available).toBe(expected);
      expect(handoffBudget({ prompt, occupancy: 0, contextWindow: 2_000_000 }).available).toBe(
        16_000,
      );
    },
  );

  it("charges text, issue and review attachments as actual rendered text", () => {
    const text = {
      type: "text" as const,
      mimeType: "text/plain" as const,
      text: "界🧪".repeat(2_000),
    };
    const issue = {
      type: "forge_issue" as const,
      mimeType: "application/paseo-forge-issue" as const,
      forge: "github",
      number: 1,
      title: "Issue",
      url: "https://example.test/1",
      body: "q".repeat(5_000),
    };
    const review = {
      type: "review" as const,
      mimeType: "application/paseo-review" as const,
      cwd: "/repo",
      mode: "uncommitted" as const,
      comments: [
        {
          filePath: "a.ts",
          side: "new" as const,
          lineNumber: 1,
          body: "Review".repeat(1_000),
          context: {
            hunkHeader: "@@",
            targetLine: {
              oldLineNumber: null,
              newLineNumber: 1,
              type: "add" as const,
              content: "new",
            },
            lines: [],
          },
        },
      ],
    };
    const blocks = [text, issue, review];
    const rendered = blocks.map(renderPromptAttachmentAsText).join("\n\n");
    expect(promptCost(blocks)).toBe(Buffer.byteLength(JSON.stringify(rendered)));
    expect(promptCost(blocks)).toBeGreaterThan(20_000);
    expect(handoffBudget({ prompt: blocks, occupancy: 0, contextWindow: 32_000 }).available).toBe(
      0,
    );
  });

  it.each([NaN, Infinity, 1.5])("rejects invalid numeric configuration %s", (value) => {
    expect(() => handoffBudget({ prompt: "", occupancy: value })).toThrow(HandoffInputError);
    expect(() => handoffBudget({ prompt: "", occupancy: 0, cap: value })).toThrow(
      HandoffInputError,
    );
    expect(() => handoffBudget({ prompt: "", occupancy: 0, contextWindow: value })).toThrow(
      HandoffInputError,
    );
  });
});
