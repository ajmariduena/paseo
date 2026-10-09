import { expect, it } from "vitest";
import { mapHandoffItems, rowIdentityKey } from "./mapping.js";
import type { HandoffSourceRow } from "./types.js";
import { HandoffInputError } from "./types.js";
import type {
  AgentTimelineItem,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";

function mapItems(items: AgentTimelineItem[]) {
  const rows: HandoffSourceRow[] = items.map((item, rowIndex) => ({
    identity: { segmentId: "source", rowIndex },
    scope: "parent",
    row: { seq: rowIndex + 100, timestamp: "", item },
  }));
  return mapHandoffItems({ rows, artifacts: [], excludeNativeRows: new Set() });
}

function tool(detail: ToolCallDetail): ToolCallTimelineItem {
  return {
    type: "tool_call",
    callId: "call:1",
    name: "tool",
    detail,
    status: "completed",
    error: null,
  };
}

it("renders read, search, fetch and worktree descriptors without native payloads", () => {
  const result = mapItems([
    tool({ type: "read", filePath: "/repo/secret.env", content: "TOKEN=abc" }),
    tool({
      type: "search",
      query: "needle",
      content: "matched file contents",
      filePaths: ["secret.env"],
      webResults: [{ title: "private", url: "https://private.test" }],
      numFiles: 2,
      numMatches: 3,
    }),
    tool({
      type: "fetch",
      url: "https://example.test",
      result: "page contents",
      prompt: "private prompt",
    }),
    tool({
      type: "worktree_setup",
      worktreePath: "/worktree",
      branchName: "feature",
      log: "setup log",
      commands: [],
    }),
    tool({ type: "plain_text", label: "Tool result", text: "hidden payload" }),
  ]);
  expect(result.items.map((item) => item.text)).toEqual([
    "Read: /repo/secret.env",
    "Search: needle\nFiles: 2\nMatches: 3",
    "Fetch: https://example.test",
    "Worktree: /worktree\nBranch: feature",
    "Tool result",
  ]);
});

it("renders an unknown tool failure once", () => {
  const failed: ToolCallTimelineItem = {
    ...tool({ type: "unknown", input: "task", output: null }),
    status: "failed",
    error: "unique failure",
  };
  const result = mapItems([failed]);
  expect(result.items[0]!.text.split("unique failure")).toHaveLength(2);
});

it("maps parent messages with stable identity and origin, excluding native and child rows", () => {
  const row: HandoffSourceRow = {
    identity: { segmentId: "segment:a", rowIndex: 4 },
    scope: "parent",
    row: {
      seq: 999,
      timestamp: "",
      item: {
        type: "user_message",
        text: "Task result",
        origin: { kind: "agent", agentId: "child:a" },
      },
    },
  };
  const result = mapHandoffItems({
    rows: [row, { ...row, scope: "child" }],
    artifacts: [],
    excludeNativeRows: new Set(),
  });
  expect(result.items).toEqual([
    {
      role: "user",
      kind: "user_message",
      text: "Task result",
      status: "completed",
      origin: { kind: "agent", agentId: "child:a" },
      provenance: { type: "row", identity: row.identity },
    },
  ]);
  expect(
    mapHandoffItems({
      rows: [row],
      artifacts: [],
      excludeNativeRows: new Set([rowIdentityKey(row.identity)]),
    }).items,
  ).toEqual([]);
});

it("ports T3 command outcomes without reasoning and preserves multilingual output", () => {
  const command: ToolCallTimelineItem = {
    type: "tool_call",
    callId: "call:command",
    name: "Bash",
    detail: {
      type: "shell",
      command: "vp test",
      output: "Failure near the end: " + "界".repeat(300),
      exitCode: 1,
    },
    status: "failed",
    error: "nonzero exit",
  };
  const result = mapItems([command, { type: "reasoning", text: "private reasoning" }]);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    role: "assistant",
    kind: "tool_call",
    status: "failed",
    origin: { kind: "tool", name: "Bash", callId: "call:command" },
  });
  expect(result.items[0]!.text).toContain("Exit code: 1");
  expect(result.items[0]!.text).toContain("界".repeat(300));
});

it("maps plans, file-change names, errors and delegated results with their parent attribution", () => {
  const result = mapItems([
    tool({ type: "plan", text: "Plan\n1. preserve context" }),
    tool({
      type: "edit",
      filePath: "src/a.ts",
      oldString: "old",
      newString: "new",
      unifiedDiff: "large diff",
    }),
    tool({ type: "write", filePath: "src/b.ts", content: "large file" }),
    { type: "error", message: "Provider failed" },
    tool({
      type: "unknown",
      input: { agentId: "child", task: "Review" },
      output: { delegatedTask: { result: "Approved", status: "completed" }, agentId: "child" },
    }),
  ]);
  expect(result.items.map((item) => item.text)).toEqual([
    "Plan\n1. preserve context",
    "File change: src/a.ts",
    "File change: src/b.ts",
    "Provider failed",
    JSON.stringify({
      tool: "tool",
      callId: "call:1",
      detail: {
        type: "unknown",
        input: { agentId: "child", task: "Review" },
        output: { delegatedTask: { result: "Approved", status: "completed" }, agentId: "child" },
      },
    }),
  ]);
  expect(result.items[3]!.status).toBe("failed");
  expect(result.items[4]!.origin).toEqual({ kind: "tool", name: "tool", callId: "call:1" });
});

it("keeps delegated task descriptors but excludes mirrored child logs and actions", () => {
  const result = mapItems([
    tool({
      type: "sub_agent",
      childSessionId: "native:child",
      subAgentType: "reviewer",
      description: "Review the code",
      log: "child reasoning and tools",
      actions: [{ index: 0, toolName: "Read", summary: "child activity" }],
    }),
  ]);
  expect(result.items[0]!.text).toBe(
    "Delegated task: Review the code\nChild: native:child\nAgent type: reviewer",
  );
});

it("drops todos, notifications, compaction and plugin rows", () => {
  const result = mapItems([
    { type: "todo", items: [{ text: "task", completed: false }] },
    { type: "notification", level: "warning", message: "notice" },
    { type: "compaction", status: "completed" },
    { type: "plugin", id: "plugin:row", pluginId: "plugin", kind: "test", version: 1, data: null },
  ]);
  expect(result).toEqual({
    items: [],
    omittedItems: [],
    sourceRows: [0, 1, 2, 3].map((rowIndex) => ({ segmentId: "source", rowIndex })),
  });
});

it("omits oversized tool activity whole and records its stable source", () => {
  const result = mapItems([
    tool({ type: "shell", command: "long", output: "界🧪".repeat(20_000), exitCode: 0 }),
  ]);
  expect(result).toEqual({
    items: [],
    omittedItems: [{ type: "row", identity: { segmentId: "source", rowIndex: 0 } }],
    sourceRows: [{ segmentId: "source", rowIndex: 0 }],
  });
});

it("preserves failed file and plan outcomes alongside their descriptive text", () => {
  const failedEdit: ToolCallTimelineItem = {
    ...tool({ type: "edit", filePath: "missing.ts" }),
    status: "failed",
    error: "File not found",
  };
  const failedPlan: ToolCallTimelineItem = {
    ...tool({ type: "plan", text: "Unaccepted plan" }),
    status: "failed",
    error: "Rejected",
  };
  expect(mapItems([failedEdit, failedPlan]).items.map((item) => item.text)).toEqual([
    'File change: missing.ts\nError: "File not found"',
    'Unaccepted plan\nError: "Rejected"',
  ]);
});

it("preserves interrupted partials and deduplicates by stable identity, not native seq", () => {
  const row: HandoffSourceRow = {
    identity: { segmentId: "a", rowIndex: 0 },
    scope: "parent",
    interrupted: true,
    row: {
      seq: 1,
      timestamp: "",
      item: { type: "assistant_message", text: "Partial\n  unchanged" },
    },
  };
  const result = mapHandoffItems({
    rows: [row, row, { ...row, identity: { segmentId: "b", rowIndex: 0 } }],
    artifacts: [],
    excludeNativeRows: new Set(),
  });
  expect(result.items.map((item) => item.status)).toEqual(["interrupted", "interrupted"]);
  expect(result.items.map((item) => item.text)).toEqual([
    "Partial\n  unchanged",
    "Partial\n  unchanged",
  ]);
  expect(result.items.map((item) => item.provenance)).toEqual([
    { type: "row", identity: row.identity },
    { type: "row", identity: { segmentId: "b", rowIndex: 0 } },
  ]);
});

it("drops complete system envelopes while preserving incomplete examples", () => {
  const result = mapItems([
    { type: "user_message", text: "<paseo-system>\nnotification\n</paseo-system>" },
    { type: "user_message", text: "<paseo-system>\nunfinished example" },
  ]);
  expect(result.items.map((item) => item.text)).toEqual(["<paseo-system>\nunfinished example"]);
  expect(result.sourceRows).toEqual([
    { segmentId: "source", rowIndex: 0 },
    { segmentId: "source", rowIndex: 1 },
  ]);
});

it.each([
  { segmentId: "", rowIndex: 0 },
  { segmentId: "source", rowIndex: -1 },
  { segmentId: "source", rowIndex: 1.5 },
  { segmentId: "source", rowIndex: NaN },
])("rejects invalid row identity $segmentId/$rowIndex", (identity) => {
  expect(() => rowIdentityKey(identity)).toThrow(HandoffInputError);
});
