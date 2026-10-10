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
    unwrapHandoffPrompt({
      prompt: result.wirePrompt,
      knownAttemptIds: new Set([input.id]),
      expectedAttemptId: input.id,
    }).prompt,
  ).toBe(input.prompt);
});

function source(rowIndex: number, text: string): HandoffSourceRow {
  return {
    identity: { segmentId: "source", rowIndex },
    scope: "parent",
    row: { seq: 9000 + rowIndex, timestamp: "", item: { type: "user_message", text } },
  };
}

it("merges coverage through reasoning, dropped kinds and oversized tools in source order", () => {
  const rows = Array.from({ length: 8 }, (_, index) => source(index, `message ${index}`));
  rows[1]!.row.item = { type: "reasoning", text: "private" };
  rows[3]!.row.item = {
    type: "tool_call",
    name: "Bash",
    callId: "large",
    status: "completed",
    error: null,
    detail: { type: "shell", command: "test", output: "x".repeat(70_000) },
  };
  rows[4]!.row.item = { type: "todo", items: [] };
  rows[6]!.row.item = { type: "reasoning", text: "private" };
  const result = buildContextHandoff({ ...input, rows });
  expect(result.coverage.ranges).toEqual([{ segmentId: "source", fromRowIndex: 0, toRowIndex: 7 }]);
  expect(result.items).toHaveLength(4);
  expect(result.omittedItems).toHaveLength(1);
});

it("keeps detailed coverage for 200 messages interleaved with reasoning", () => {
  const rows: HandoffSourceRow[] = [];
  for (let index = 0; index < 200; index++) {
    rows.push(source(index * 2, `Message ${index}`));
    const reasoning = source(index * 2 + 1, "");
    reasoning.row.item = { type: "reasoning", text: "private" };
    rows.push(reasoning);
  }
  const result = buildContextHandoff({ ...input, rows });
  expect(result.coverage.ranges).toEqual([
    { segmentId: "source", fromRowIndex: 0, toRowIndex: 399 },
  ]);
  expect(result.coverage.collapsed).toBe(false);
  expect(result.items.length + result.omittedItems.length).toBe(200);
});

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
    unwrapHandoffPrompt({
      prompt: result.wirePrompt,
      knownAttemptIds: new Set([input.id]),
      expectedAttemptId: input.id,
    }).prompt,
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
    unwrapHandoffPrompt({
      prompt: result.wirePrompt,
      knownAttemptIds: new Set([input.id]),
      expectedAttemptId: input.id,
    }).prompt,
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
  expect(result.wirePrompt).toContain("Restart &lt;cancelled> work");
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
  expect(result.coverage.text).toContain("dropped:retired:0-8");
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

it("sorts and merges source ranges without covering excluded native rows or child panes", () => {
  const row0 = source(0, "zero");
  const native = source(1, "native");
  const row2 = source(2, "two");
  const child: HandoffSourceRow = { ...source(3, "child"), scope: "child" };
  const other = { ...source(0, "other"), identity: { segmentId: "earlier", rowIndex: 0 } };
  const result = buildContextHandoff({
    ...input,
    rows: [row2, native, child, row0, other, row0],
    excludeNativeRows: new Set([rowIdentityKey(native.identity)]),
  });
  expect(result.coverage.ranges).toEqual([
    { segmentId: "earlier", fromRowIndex: 0, toRowIndex: 0 },
    { segmentId: "source", fromRowIndex: 0, toRowIndex: 0 },
    { segmentId: "source", fromRowIndex: 2, toRowIndex: 2 },
  ]);
  expect(result.coverage.text).toContain("Source ranges: earlier:0-0, source:0-0, source:2-2.");
});

it("fits more of a 60-message chat and bounds the actual escaped wire prefix", () => {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const row = source(index, "x".repeat(100));
    if (index % 2) row.row.item = { type: "assistant_message", text: "x".repeat(100) };
    return row;
  });
  const result = buildContextHandoff({ ...input, prompt: "original prompt", rows });
  expect(result.items.length).toBeGreaterThanOrEqual(50);
  expect(result.cost).toBeLessThanOrEqual(16_000);
  if (typeof result.wirePrompt !== "string") throw new Error("Expected string prompt");
  const prefix = result.wirePrompt.slice(0, -"original prompt".length);
  expect(Buffer.byteLength(JSON.stringify(prefix)) + 256).toBeLessThanOrEqual(result.cost);
});

it("a recent 15KB read does not displace older messages or forward file content", () => {
  const rows = Array.from({ length: 20 }, (_, index) => source(index, `request ${index}`));
  const read = source(20, "");
  read.row.item = {
    type: "tool_call",
    name: "Read",
    callId: "read",
    status: "completed",
    error: null,
    detail: { type: "read", filePath: "/repo/secret.env", content: "private".repeat(2_200) },
  };
  const result = buildContextHandoff({ ...input, rows: [...rows, read] });
  expect(result.items).toHaveLength(21);
  expect(result.items.at(-1)!.text).toBe("Read: /repo/secret.env");
  expect(result.wirePrompt).not.toContain("private");
});
