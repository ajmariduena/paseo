import { expect, it } from "vitest";
import { buildContextHandoff, type ContextHandoffInput } from "./handoff.js";
import { unwrapHandoffPrompt } from "./envelope.js";
import { HandoffBudgetError } from "./history.js";
import { rowIdentityKey } from "./mapping.js";
import type { AgentPromptInput } from "../agent-sdk-types.js";
import type { HandoffSourceRow, MissingCoverage } from "./types.js";

const input: ContextHandoffInput = {
  id: "attempt:one",
  from: "claude",
  to: "codex",
  prompt: "Continue",
  occupancy: 0,
  rows: [],
  artifacts: [],
  excludeNativeRows: new Set(),
  missingCoverage: [],
  receivesPaseoTools: true,
};

it("builds a self-contained handoff and keeps canonical and wire prompts separate", () => {
  const result = buildContextHandoff(input);
  expect(result.canonicalPrompt).toBe("Continue");
  expect(result.wirePrompt).toContain("get_agent_activity");
  expect(result.wirePrompt).toContain("User message:\nContinue");
  expect(result.budget.unknownWindow).toBe(true);
  expect(result.cost).toBeLessThanOrEqual(result.budget.available);
  expect(
    unwrapHandoffPrompt({ prompt: result.wirePrompt, knownAttemptIds: new Set([input.id]) }),
  ).toBe(input.prompt);
});

function source(rowIndex: number, text: string): HandoffSourceRow {
  return {
    identity: { segmentId: "source", rowIndex },
    scope: "parent",
    row: { seq: 9000 + rowIndex, timestamp: "", item: { type: "user_message", text } },
  };
}

it("excludes already native rows and subtracts deferred-command occupancy", () => {
  const native = source(2, "already native slash skill");
  const result = buildContextHandoff({
    ...input,
    contextWindow: 32_000,
    occupancy: 12_000,
    rows: [source(1, "old request"), native],
    excludeNativeRows: new Set([rowIdentityKey(native.identity)]),
  });
  expect(result.budget.available).toBe(3_990);
  expect(result.items.map((item) => item.text)).toEqual(["old request"]);
  expect(result.wirePrompt).not.toContain("already native slash skill");
  expect(result.wirePrompt).not.toContain("9001");
  expect(result.coverage.ranges).toEqual([{ segmentId: "source", fromRowIndex: 1, toRowIndex: 1 }]);
});

it("omits large historical items without refusing or truncating the current prompt", () => {
  const prompt = "  Keep original\n界🧪\n";
  const result = buildContextHandoff({ ...input, prompt, rows: [source(0, "x".repeat(100_000))] });
  expect(result.items).toEqual([]);
  expect(result.omittedItems).toEqual([
    { type: "row", identity: { segmentId: "source", rowIndex: 0 } },
  ]);
  expect(
    unwrapHandoffPrompt({ prompt: result.wirePrompt, knownAttemptIds: new Set([input.id]) }),
  ).toBe(prompt);
});

it("refuses oversized input and attachments even with no history", () => {
  expect(() => buildContextHandoff({ ...input, prompt: "界".repeat(60_000) })).toThrow(
    HandoffBudgetError,
  );
  expect(() =>
    buildContextHandoff({
      ...input,
      prompt: [{ type: "text", mimeType: "text/plain", text: "x".repeat(100_000) }],
    }),
  ).toThrow(HandoffBudgetError);
  expect(() => buildContextHandoff({ ...input, contextWindow: 16_100 })).toThrow(
    HandoffBudgetError,
  );
});

it("leads block prompts with an envelope and preserves attachments in their original order", () => {
  const prompt: AgentPromptInput = [
    { type: "text", mimeType: "text/plain", contextKind: "chat_history", text: "legacy context" },
    { type: "text", text: "question" },
    { type: "image", data: "encoded", mimeType: "image/png" },
    { type: "text", mimeType: "text/plain", text: "last attachment" },
  ];
  const result = buildContextHandoff({ ...input, prompt });
  expect(result.canonicalPrompt).toBe(prompt);
  expect(result.wirePrompt).toEqual([
    expect.objectContaining({ type: "text", text: expect.stringContaining("User message:\n") }),
    ...prompt,
  ]);
  expect(
    unwrapHandoffPrompt({ prompt: result.wirePrompt, knownAttemptIds: new Set([input.id]) }),
  ).toEqual(prompt);
});

it("retains legacy fork artifacts and charges restart notes and escaped attributes", () => {
  const artifact = { id: "fork:one", text: "Inherited constraints", origin: "fork:parent" };
  const result = buildContextHandoff({
    ...input,
    artifacts: [artifact, artifact],
    restartNote: "Restart <cancelled> work",
  });
  expect(result.items.map((item) => item.text)).toEqual([artifact.text]);
  expect(result.wirePrompt).toContain("Restart &lt;cancelled&gt; work");
  expect(result.cost).toBeGreaterThan(buildContextHandoff(input).cost);
  expect(() => buildContextHandoff({ ...input, from: "<&".repeat(4_000) })).toThrow(
    HandoffBudgetError,
  );
});

it("collapses accumulated coverage while preserving durable missing ranges and useful history", () => {
  const missingCoverage: MissingCoverage[] = Array.from({ length: 100 }, (_, index) => ({
    reason: "unavailable",
    range: { segmentId: `missing:${index}`, fromRowIndex: 0, toRowIndex: 99 },
  }));
  const result = buildContextHandoff({
    ...input,
    cap: 2_500,
    rows: [source(0, "remember this")],
    missingCoverage,
  });
  expect(result.coverage.collapsed).toBe(true);
  expect(result.coverage.missing).toEqual(missingCoverage);
  expect(result.coverage.text).toContain("100 dropped/unavailable ranges");
  expect(result.coverage.text).toContain("Detailed coverage references omitted");
  expect(result.items.map((item) => item.text)).toEqual(["remember this"]);
  expect(result.cost).toBeLessThanOrEqual(2_500);
});

it("names the existing history tool only when available to the target", () => {
  expect(buildContextHandoff({ ...input, receivesPaseoTools: false }).wirePrompt).not.toContain(
    "get_agent_activity",
  );
  expect(buildContextHandoff(input).wirePrompt).toContain("get_agent_activity");
});

it("admits the minimal envelope at the minimum configured cap", () => {
  const result = buildContextHandoff({ ...input, cap: 1_024 });
  expect(result.cost).toBeLessThanOrEqual(1_024);
});

it("keeps dropped coverage with stable ranges and omits oversized legacy artifacts whole", () => {
  const missingCoverage: MissingCoverage[] = [
    { reason: "dropped", range: { segmentId: "retired", fromRowIndex: 0, toRowIndex: 8 } },
  ];
  const result = buildContextHandoff({
    ...input,
    missingCoverage,
    artifacts: [{ id: "legacy", text: "huge".repeat(30_000), origin: "fork:old" }],
  });
  expect(result.coverage.missing).toEqual(missingCoverage);
  expect(result.coverage.text).toContain('"reason":"dropped"');
  expect(result.coverage.text).not.toMatch(/seq|afterPosition|itemPosition/);
  expect(result.omittedItems).toEqual([{ type: "artifact", id: "legacy", origin: "fork:old" }]);
  expect(result.items).toEqual([]);
});

it("uses the configured history cap for whole tool results larger than the default cap", () => {
  const row = source(0, "");
  row.row.item = {
    type: "tool_call",
    name: "Bash",
    callId: "call",
    status: "completed",
    error: null,
    detail: { type: "shell", command: "test", exitCode: 0, output: "x".repeat(20_000) },
  };
  expect(buildContextHandoff({ ...input, rows: [row] }).items).toEqual([]);
  expect(buildContextHandoff({ ...input, cap: 64_000, rows: [row] }).items).toHaveLength(1);
});
